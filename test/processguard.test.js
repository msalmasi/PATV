// 1.99anx: processguard.js - the process-wide crash guard, now on the website (index.js, "[site]") as well as the Twitch
// webhook server (server.js, "[server]", test/twitch-channelpoints.test.js keeps pinning that one).
//   * an unhandled rejection is logged (errInfo + frames only) and the process keeps running; an uncaught exception is logged
//     and exits 1; the prefix names the process
//   * BOOT (index.js): until ready() (its listen callback) + SETTLE_MS an unhandled rejection is still fatal (exit 1)
//   * the throttle: one line per signature per minute ("+k more since", "repeated k more times"), 10 lines a minute in all
//     (+ one "not logged" line), 500 signatures; every rejection is printed or counted (a randomised conservation check)
//   * never the error object: an AxiosError-like rejection with config.headers / request / a request body prints none of them
//   * the handlers never throw (a throwing logger / exit / timer, a hostile error object)
//   * real child processes: the guard alone (before / after ready, an uncaught exception, 1000 rejections -> one line, the summary
//     timer never keeps a process alive) and the REAL index.js booted in a scratch folder (a rejection while it loads exits 1;
//     its port taken exits 1; one after it is up + 10 s is survived and /healthz still answers; then an uncaught exception exits 1)
//   * source: index.js installs the guard as its first statement and calls ready() in its listen callback; nothing else in the
//     site installs its own process handlers; channelpoints.js re-exports processguard's errInfo / frames / guardProcess
//   NODE_PATH=G:/PATV/node_modules node --test test/processguard.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const PG = require(path.join(repo, "processguard"));
const CP = require(path.join(repo, "twitchbot", "channelpoints"));

/** A guard on a fake clock + fake timers. */
function rig(o = {}) {
  let t = 5000000;
  const logs = [], args = [], exits = [], timers = [];
  const g = PG.createGuard(Object.assign({
    label: "site",
    warn: (...a) => { args.push(a); logs.push(a.join(" ")); },
    exit: (c) => exits.push(c),
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
  }, o));
  return {
    g, logs, args, exits, timers,
    adv(ms) { t += ms; },
    fire() { const ts = timers.splice(0); for (const h of ts) h.fn(); return ts.length; },
    up() { g.ready(); t += PG.SETTLE_MS; },          // listening, and the settle window is over
  };
}
/** An error with a fixed message and top frame (its signature). */
const errAt = (msg, fn, extra = {}) => Object.assign(new Error(msg), { stack: `Error: ${msg}\n    at ${fn} (/app/${fn}.js:1:1)\n    at next (/app/x.js:2:2)` }, extra);

/** An AxiosError-like object as axios 1.x builds it: config (headers + the request body), request, response. */
function axiosLike(status = 401) {
  const config = { url: "https://api.example.test/x", method: "post",
                   headers: { Authorization: "Bearer FAKE-TOKEN-1234", "X-PATV-Key": "bot.FAKE-KEY-5678", "X-Bot-Token": "FAKE-BOT-9" },
                   data: '{"password":"FAKE-PASSWORD","email":"someone@example.test"}' };
  const request = { _header: "POST /x HTTP/1.1\r\nAuthorization: Bearer FAKE-TOKEN-1234\r\n\r\n", method: "POST" };
  const e = new Error("Request failed with status code " + status);
  return Object.assign(e, { name: "AxiosError", code: "ERR_BAD_REQUEST", isAxiosError: true, config, request,
                            response: { status, statusText: "Unauthorized", headers: { "set-cookie": "FAKE-COOKIE" }, config, request,
                                        data: { error: "Unauthorized", message: "Invalid OAuth token" } },
                            toJSON() { return { config, message: e.message }; } });
}
const FAKE = /FAKE-|someone@example|password/;

// ── the basics ──
test("an unhandled rejection is logged under the process's label and the process keeps running; an uncaught exception exits 1", () => {
  const r = rig();
  r.up();
  r.g.onRejection(errAt("db is locked", "tick"));
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /^\[site\] unhandled rejection \(kept running\): db is locked @ at tick \(\/app\/tick\.js:1:1\) \| at next /);
  r.g.onRejection("Not connected to server.");
  assert.match(r.logs[1], /^\[site\] unhandled rejection \(kept running\): Not connected to server\.$/);
  r.g.onRejection(undefined);
  assert.match(r.logs[2], /kept running\): undefined$/);
  assert.deepEqual(r.exits, []);
  r.g.onException(errAt("boom", "handler"));
  assert.match(r.logs[3], /^\[site\] uncaught exception - exiting: boom @ at handler /);
  assert.deepEqual(r.exits, [1]);
  for (const a of r.args) assert.ok(a.length === 1 && typeof a[0] === "string", "one string per line, never an object");
  const odd = rig({ label: "we ird\n[x]" });
  odd.g.onException(new Error("x"));
  assert.match(odd.logs[0], /^\[weirdx\] uncaught exception/, "the label can't break the line");
  assert.equal(rig({ label: "" }).g.label, "process");
});

test("BOOT: fatal (logged, exit 1) until ready() + SETTLE_MS, then survived; ready() twice doesn't restart the window", () => {
  assert.equal(PG.SETTLE_MS, 10000, "the window the header comment justifies");
  const r = rig({ bootFatal: true });
  assert.equal(r.g.inBoot(), true);
  r.g.onRejection(errAt("SQLITE_ERROR: no such table: users", "createTables"));
  assert.match(r.logs[0], /^\[site\] unhandled rejection during startup - exiting: SQLITE_ERROR: no such table: users @ at createTables /);
  assert.deepEqual(r.exits, [1]);
  r.g.ready();
  r.adv(PG.SETTLE_MS - 1);
  r.g.ready();                                                   // a second call (a second listen callback) changes nothing
  r.g.onRejection(errAt("still starting", "ensure"));
  assert.match(r.logs[1], /during startup - exiting: still starting/);
  assert.deepEqual(r.exits, [1, 1], "inside the settle window: still fatal");
  r.adv(1);
  assert.equal(r.g.inBoot(), false);
  r.g.onRejection(errAt("one request failed", "route"));
  assert.match(r.logs[2], /^\[site\] unhandled rejection \(kept running\): one request failed/);
  assert.deepEqual(r.exits, [1, 1], "after it: kept running");
  assert.equal(r.g.stats.fatal, 2);
  // the boot lines are never throttled: the same rejection twice during boot prints twice
  const b = rig({ bootFatal: true });
  b.g.onRejection(errAt("x", "a")); b.g.onRejection(errAt("x", "a"));
  assert.equal(b.logs.length, 2); assert.deepEqual(b.exits, [1, 1]);
  // no bootFatal (server.js): survived from the start, ready() or not
  const s = rig({ label: "server" });
  s.g.onRejection(errAt("site down", "spin"));
  assert.match(s.logs[0], /^\[server\] unhandled rejection \(kept running\): site down/);
  assert.deepEqual(s.exits, []);
});

test("guardProcess: once per process (process.__patvGuarded) - shared by channelpoints.js ([server]) and index.js ([site]); ready(proc)", () => {
  const proc = new EventEmitter();
  const logs = [], exits = [];
  PG.guardProcess(proc, { label: "site", bootFatal: true, warn: (l) => logs.push(l), exit: (c) => exits.push(c) });
  PG.guardProcess(proc, { label: "other", warn: () => assert.fail("second install") });
  CP.guardProcess(proc, { warn: () => assert.fail("second install") });
  assert.equal(proc.__patvGuarded, true);
  assert.equal(proc.listenerCount("unhandledRejection"), 1);
  assert.equal(proc.listenerCount("uncaughtException"), 1);
  assert.equal(Object.keys(proc).includes("__patvGuard"), false, "the guard object isn't enumerable on process");
  proc.emit("unhandledRejection", new Error("early"));
  assert.deepEqual(exits, [1], "before ready: fatal");
  assert.equal(PG.ready(proc), true);
  assert.equal(PG.ready(new EventEmitter()), false, "no guard: nothing to tell");
  assert.equal(PG.ready(null), false);
  // channelpoints' wrapper is processguard's guard as "[server]" - and never boot-fatal, whatever it is passed
  const sp = new EventEmitter(), sl = [], se = [];
  CP.guardProcess(sp, { bootFatal: true, warn: (l) => sl.push(l), exit: (c) => se.push(c) });
  sp.emit("unhandledRejection", new Error("site down"));
  assert.match(sl[0], /^\[server\] unhandled rejection \(kept running\): site down/);
  assert.deepEqual(se, []);
  assert.equal(CP.errInfo, PG.errInfo);
  assert.equal(CP.frames, PG.frames);
  // the default exit is the process's own
  const ep = new EventEmitter(); const codes = []; ep.exit = (c) => codes.push(c);
  PG.guardProcess(ep, { label: "site", warn: () => {} });
  ep.emit("uncaughtException", new Error("x"));
  assert.deepEqual(codes, [1]);
});

// ── never the error object ──
test("an AxiosError-like rejection / exception prints status + answer + frames - never config, headers, request or a request body", () => {
  for (const boot of [false, true]) {
    const r = rig({ bootFatal: boot });
    if (!boot) r.up();
    r.g.onRejection(axiosLike(401));
    r.g.onException(axiosLike(502));
    const all = r.logs.join("\n");
    assert.match(r.logs[0], boot ? /during startup - exiting: HTTP 401 \{"error":"Unauthorized","message":"Invalid OAuth token"\} @ at /
                                 : /kept running\): HTTP 401 \{"error":"Unauthorized","message":"Invalid OAuth token"\} @ at /);
    assert.match(r.logs[1], /uncaught exception - exiting: HTTP 502 /);
    assert.doesNotMatch(all, FAKE);
    assert.doesNotMatch(all, /Authorization|X-PATV-Key|X-Bot-Token|set-cookie|headers|config/i);
  }
  // a network error (no response): code + message only
  const r = rig(); r.up();
  const netErr = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED", config: axiosLike().config });
  r.g.onRejection(netErr);
  assert.match(r.logs[0], /kept running\): ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:9 @ at /);
  assert.doesNotMatch(r.logs.join("\n"), FAKE);
});

test("the handlers never throw: a hostile reason, a throwing logger / exit / timer; a huge stack is cut to MAX_LINE", () => {
  const hostile = new Proxy({}, { get() { throw new Error("FAKE-getter"); }, has() { throw new Error("FAKE-has"); } });
  const getters = Object.defineProperty(Object.defineProperty({}, "response", { get() { throw new Error("FAKE-r"); } }),
                                        "stack", { get() { throw new Error("FAKE-s"); } });
  const r = rig(); r.up();
  assert.doesNotThrow(() => r.g.onRejection(hostile));
  assert.doesNotThrow(() => r.g.onRejection(getters));
  assert.doesNotThrow(() => r.g.onException(hostile));
  assert.match(r.logs[0], /kept running\): \[unreadable error\]$/);
  assert.doesNotMatch(r.logs.join("\n"), FAKE);
  assert.deepEqual(r.exits, [1]);
  const bad = PG.createGuard({ label: "site", bootFatal: true, warn: () => { throw new Error("log full"); },
                               exit: () => { throw new Error("no exit"); }, setTimer: () => { throw new Error("no timers"); } });
  assert.doesNotThrow(() => bad.onRejection(new Error("a")));          // boot: logs (throws), exits (throws)
  bad.ready();
  assert.doesNotThrow(() => { for (let i = 0; i < 50; i++) bad.onRejection(new Error("b")); });   // counted -> schedule() throws
  assert.doesNotThrow(() => bad.flush());
  assert.doesNotThrow(() => bad.onException(new Error("c")));
  const big = rig(); big.up();
  const huge = Object.assign(new Error("x".repeat(5000)), { stack: "Error\n" + Array.from({ length: 50 }, (_, i) => `    at f${i} (/${"d".repeat(900)}.js:1:1)`).join("\n") });
  big.g.onRejection(huge); big.g.onException(huge);
  for (const l of big.logs) assert.ok(l.length <= PG.MAX_LINE, "bounded: " + l.length);
});

// ── the throttle ──
test("throttle: one line per signature per minute; '+k more since' on its next line, or a 'repeated' line when its minute is up", () => {
  assert.equal(PG.SAME_MS, 60000);
  const r = rig(); r.up();
  const A = () => errAt("SQLITE_BUSY: database is locked", "hotRoute");
  r.g.onRejection(A());
  for (let i = 0; i < 4; i++) { r.adv(1000); r.g.onRejection(A()); }
  assert.equal(r.logs.length, 1, "one line for five");
  assert.equal(r.timers.length, 1, "one summary timer");
  assert.equal(r.timers[0].ms, PG.SAME_MS);
  r.adv(57000);                                                  // 61 s after the line: the same rejection again, before the timer
  r.g.onRejection(A());
  assert.match(r.logs[1], /^\[site\] unhandled rejection \(kept running\): SQLITE_BUSY: database is locked @ at hotRoute .* \(\+4 more since 61 s ago\)$/);
  r.fire();
  assert.equal(r.logs.length, 2, "nothing pending: no summary");
  assert.equal(r.timers.length, 0, "and no new timer");
  // it never comes back after a burst: the timer reports it
  for (let i = 0; i < 9; i++) { r.adv(100); r.g.onRejection(A()); }
  r.adv(PG.SAME_MS); r.fire();
  assert.match(r.logs[2], /^\[site\] unhandled rejection repeated 9 more times in the last 61 s \(kept running; not logged one by one\): SQLITE_BUSY: database is locked @ at hotRoute \(\/app\/hotRoute\.js:1:1\)$/);
  // a different message or a different top frame is another signature
  r.g.onRejection(errAt("SQLITE_BUSY: database is locked", "otherRoute"));
  r.g.onRejection(errAt("other message", "hotRoute"));
  assert.equal(r.logs.length, 5);
  // an HTTP answer's body isn't part of the signature (it may carry an id / a time)
  const h = rig(); h.up();
  const withBody = (b) => Object.assign(errAt("Request failed with status code 500", "post"), { response: { status: 500, data: b } });
  h.g.onRejection(withBody("req 1")); h.g.onRejection(withBody("req 2"));
  assert.equal(h.logs.length, 1);
  h.g.onRejection(Object.assign(errAt("Request failed with status code 500", "post"), { response: { status: 503, data: "x" } }));
  assert.equal(h.logs.length, 2, "another status is another signature");
});

test("throttle: at most CAP_PER_MIN lines a minute in all, then ONE 'not logged' line for the minute; a capped signature prints in full later", () => {
  assert.equal(PG.CAP_PER_MIN, 10);
  const r = rig(); r.up();
  for (let i = 0; i < 25; i++) r.g.onRejection(errAt("distinct " + i, "f" + i));
  assert.equal(r.logs.length, 10);
  assert.equal(r.timers.length, 1);
  r.adv(60000); r.fire();
  assert.equal(r.logs.length, 11);
  assert.match(r.logs[10], /^\[site\] unhandled rejections: 15 more not logged in the last minute \(rate cap 10 lines a minute; 15 kinds\) - kept running$/);
  assert.equal(r.timers.length, 0, "nothing pending");
  r.g.onRejection(errAt("distinct 24", "f24"));
  assert.match(r.logs[11], /kept running\): distinct 24 @ at f24 /, "a signature the cap swallowed prints in full once it may");
  // a signature's pending count that can't be printed under the cap moves into the 'not logged' count
  const c = rig({ capPerMin: 2 }); c.up();
  c.g.onRejection(errAt("A", "a")); c.g.onRejection(errAt("A", "a")); c.g.onRejection(errAt("A", "a"));   // 1 line, 2 pending
  c.adv(60000);
  c.g.onRejection(errAt("D", "d")); c.g.onRejection(errAt("E", "e"));                                      // the new minute is full
  c.fire();                                                                                                 // A's summary: capped
  assert.equal(c.logs.length, 3);
  c.adv(60000); c.fire();
  assert.match(c.logs[3], /: 2 more not logged in the last minute \(rate cap 2 lines a minute; 1 kind\)/);
});

test("throttle: at most MAX_SIGS signatures remembered; a dropped one's pending count goes to the 'not logged' line", () => {
  assert.equal(PG.MAX_SIGS, 500);
  const r = rig({ maxSigs: 2, capPerMin: 100 }); r.up();
  r.g.onRejection(errAt("A", "a")); r.g.onRejection(errAt("A", "a"));     // A printed, 1 pending
  r.g.onRejection(errAt("B", "b"));
  r.g.onRejection(errAt("C", "c"));                                        // A dropped
  assert.equal(r.g._sigs.size, 2);
  r.adv(60000); r.fire();
  assert.match(r.logs.at(-1), /: 1 more not logged in the last minute/);
});

test("throttle: every rejection is printed or counted (a randomised run, then the exit line)", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let run = 0; run < 5; run++) {
    const r = rig({ capPerMin: 1 + run * 3, maxSigs: 3 + run * 5 }); r.up();
    let total = 0;
    for (let i = 0; i < 3000; i++) {
      const k = Math.floor(rnd() * (run === 4 ? 40 : 8));
      r.g.onRejection(rnd() < 0.1 ? "plain " + k : errAt("m" + k, "f" + (k % 5)));
      total++;
      r.adv(Math.floor(rnd() * 400));
      if (rnd() < 0.02) r.fire();
    }
    r.g.onException(new Error("the end"));
    let counted = 0;
    for (const l of r.logs) {
      if (/uncaught exception - exiting/.test(l)) continue;
      let m;
      if ((m = /^\[site\] unhandled rejection repeated (\d+) more time/.exec(l))) counted += +m[1];
      else if ((m = /^\[site\] unhandled rejections: (\d+) more not logged/.exec(l))) counted += +m[1];
      else if ((m = /^\[site\] \((\d+) unhandled rejections? since the last lines above were not logged/.exec(l))) counted += +m[1];
      else if (/^\[site\] unhandled rejection \(kept running\): /.test(l)) {
        counted += 1;
        if ((m = /\(\+(\d+) more since \d+ s ago\)$/.exec(l))) counted += +m[1];
      } else assert.fail("unexpected line: " + l);
    }
    assert.equal(counted, total, `run ${run}: printed + counted = every rejection`);
    assert.deepEqual(r.exits, [1]);
  }
});

// ── real child processes ──
const nodeEnv = () => {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
                "NODE_PATH", "LANG", "APPDATA", "LOCALAPPDATA", "ComSpec", "PATHEXT"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
};
const guardScript = (body, { guard = true, settleMs } = {}) => `
  const PG = require(${JSON.stringify(path.join(repo, "processguard"))});
  ${guard ? `PG.guardProcess(process, { label: "site", bootFatal: true${settleMs != null ? ", settleMs: " + settleMs : ""} });` : ""}
  function axiosLike() {
    const e = new Error("connect ECONNREFUSED 127.0.0.1:9"); e.code = "ECONNREFUSED";
    e.config = { headers: { Authorization: "Bearer FAKE-TOKEN-1234", "X-PATV-Key": "bot.FAKE-KEY" }, data: '{"password":"FAKE-PASSWORD"}' };
    return e;
  }
  ${body}`;
const runNode = (src) => spawnSync(process.execPath, ["-e", src], { encoding: "utf8", timeout: 30000, env: nodeEnv() });

test("a real Node process: before ready() a rejection exits 1; after ready + settle it is survived; an uncaught exception exits 1", () => {
  const early = runNode(guardScript(`Promise.reject(axiosLike()); setTimeout(() => console.log("still running"), 300);`));
  assert.equal(early.status, 1, early.stderr);
  assert.doesNotMatch(early.stdout, /still running/);
  assert.match(early.stderr, /^\[site\] unhandled rejection during startup - exiting: ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:9 @ at /m);
  assert.doesNotMatch(early.stderr + early.stdout, FAKE);

  const late = runNode(guardScript(`
    const srv = require("http").createServer((q, s) => s.end("ok")).listen(0, "127.0.0.1", () => {
      PG.ready(process);
      setTimeout(() => {
        Promise.reject(axiosLike());
        setTimeout(() => require("http").get("http://127.0.0.1:" + srv.address().port + "/", (res) => {
          res.resume(); console.log("still serving " + res.statusCode); srv.close();
        }), 100);
      }, 250);
    });`, { settleMs: 100 }));
  assert.equal(late.status, 0, late.stderr);
  assert.match(late.stdout, /still serving 200/);
  assert.match(late.stderr, /^\[site\] unhandled rejection \(kept running\): ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:9 @ at /m);
  assert.doesNotMatch(late.stderr + late.stdout, FAKE);

  const thrown = runNode(guardScript(`PG.ready(process); setTimeout(() => { throw axiosLike(); }, 200); setTimeout(() => console.log("still running"), 600);`, { settleMs: 0 }));
  assert.equal(thrown.status, 1, thrown.stderr);
  assert.doesNotMatch(thrown.stdout, /still running/);
  assert.match(thrown.stderr, /^\[site\] uncaught exception - exiting: ECONNREFUSED /m);
  assert.doesNotMatch(thrown.stderr + thrown.stdout, FAKE);

  const bare = runNode(guardScript(`Promise.reject(axiosLike());`, { guard: false }));
  assert.notEqual(bare.status, 0, "control: without the guard Node exits ...");
  assert.match(bare.stderr, /FAKE-TOKEN-1234/, "... and prints the error's headers");
});

test("a real Node process: 1000 rejections from one hot path -> one line, and the pending summary never keeps the process alive", () => {
  const t0 = Date.now();
  const r = runNode(guardScript(`PG.ready(process);
    setTimeout(() => { for (let i = 0; i < 1000; i++) (function hot() { Promise.reject(axiosLike()); })(); }, 50);
    setTimeout(() => console.log("done"), 300);`, { settleMs: 0 }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /done/);
  assert.equal((r.stderr.match(/unhandled rejection \(kept running\)/g) || []).length, 1, r.stderr);
  assert.ok(Date.now() - t0 < 20000, "exited on its own, well before the 60 s summary timer");
});

// ── the REAL index.js, booted in a scratch folder ──
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}
const get = (port, p) => new Promise((res) => {
  const q = http.get({ host: "127.0.0.1", port, path: p, timeout: 5000, agent: false }, (r) => {
    let b = ""; r.setEncoding("utf8"); r.on("data", (d) => (b += d)); r.on("end", () => res({ status: r.statusCode, body: b }));
  });
  q.on("error", (e) => res({ status: 0, body: e.code || e.message }));
  q.on("timeout", () => q.destroy(new Error("timeout")));
});
/** node -r <preload> index.js in a fresh folder (no .env, a new myapp.db; only PATH-like variables from this environment, so no
 *  real key reaches it). -> {child, dir, port, out(), err(), waitFor(re, ms), exited, exitWithin(ms), cleanup()} */
async function bootIndex(preload, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "processguard-index-"));
  const pre = path.join(dir, "preload.js");
  fs.writeFileSync(pre, `"use strict";\n${preload}\n`);
  const port = opts.port || await freePort();
  const env = Object.assign(nodeEnv(), { PORT: String(port), BIND_HOST: "127.0.0.1", SECRET_KEY: "test-secret-processguard",
                                         APP_SESSION_SECRET: "test-session-processguard", RESEND_API_KEY: "re_test_processguard",
                                         SETTLE_PLUS_MS: String(PG.SETTLE_MS + 1500) });
  const child = spawn(process.execPath, ["-r", pre, path.join(repo, "index.js")], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
  let done = false; exited.then(() => { done = true; });
  const waitFor = async (re, ms) => {
    const t0 = Date.now();
    while (!re.test(out + "\n" + err)) {
      if (done || Date.now() - t0 > ms) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  };
  /** -> {code, signal} once it exits, or null after ms (the timer is cleared: it never holds the test process open) */
  const exitWithin = (ms) => new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    exited.then((r) => { clearTimeout(t); res(r); });
  });
  const cleanup = async () => {
    if (!done) { child.kill(); await exited; }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch (e) { await new Promise((r) => setTimeout(r, 300)); } }
  };
  return { child, dir, port, out: () => out, err: () => err, waitFor, exited, exitWithin, cleanup };
}
const FAKE_ERR = `function fakeAxios(msg) {
  const e = new Error(msg); e.code = "ERR_BAD_REQUEST";
  e.config = { headers: { Authorization: "Bearer FAKE-TOKEN-1234", "X-PATV-Key": "bot.FAKE-KEY" }, data: '{"password":"FAKE-PASSWORD"}' };
  e.response = { status: 401, data: { error: "Unauthorized" }, config: e.config };
  return e;
}`;

test("the real index.js: a rejection while it starts exits 1 (the updater still rolls a broken boot back)", { timeout: 120000 }, async () => {
  // setImmediate: right after index.js's synchronous load - its routes are registered, it isn't listening yet
  const b = await bootIndex(`${FAKE_ERR}\nsetImmediate(() => { Promise.reject(fakeAxios("migration failed")); });`);
  try {
    const r = await b.exitWithin(90000);
    assert.ok(r, "it exited by itself:\n" + b.err().slice(-2000));
    assert.equal(r.code, 1, b.err().slice(-2000));
    assert.match(b.err(), /^\[site\] unhandled rejection during startup - exiting: HTTP 401 \{"error":"Unauthorized"\} @ at /m);
    assert.doesNotMatch(b.out() + b.err(), FAKE);
  } finally { await b.cleanup(); }
});

test("the real index.js: its port already taken (listen fails, EADDRINUSE) is an uncaught exception - logged, exit 1", { timeout: 120000 }, async () => {
  const held = net.createServer();
  await new Promise((res) => held.listen(0, "127.0.0.1", res));
  const b = await bootIndex("", { port: held.address().port });
  try {
    const r = await b.exitWithin(90000);
    assert.ok(r, "it exited by itself:\n" + b.err().slice(-2000));
    assert.equal(r.code, 1, b.err().slice(-2000));
    assert.match(b.err(), /^\[site\] uncaught exception - exiting: EADDRINUSE listen EADDRINUSE/m);
    assert.doesNotMatch(b.out(), /Server running on /, "it never said it was up");
  } finally { await b.cleanup(); await new Promise((res) => held.close(res)); }
});

test("the real index.js: up + 10 s, a rejection is logged and /healthz still answers; then an uncaught exception exits 1", { timeout: 150000 }, async () => {
  const b = await bootIndex(`${FAKE_ERR}
const log = console.log;
let seen = false;
console.log = function (...a) {
  if (!seen && /^Server running on /.test(String(a[0]))) {
    seen = true;
    setTimeout(() => {
      Promise.reject(fakeAxios("Request failed with status code 401"));
      setTimeout(() => process.stdout.write("PRELOAD-REJECTED\\n"), 50);
    }, Number(process.env.SETTLE_PLUS_MS));
  }
  return log.apply(this, a);
};
// the test drops a file named throw-now into the folder: then a timer throws (an uncaught exception, outside any try)
const fs = require("fs");
setInterval(() => {
  let go = false;
  try { go = fs.existsSync("throw-now"); if (go) fs.unlinkSync("throw-now"); } catch (e) { /* next tick */ }
  if (go) setTimeout(() => { throw fakeAxios("handler blew up"); }, 10);
}, 100);`);
  try {
    assert.ok(await b.waitFor(/Server running on /, 90000), "booted:\n" + b.err().slice(-2000));
    const h1 = await get(b.port, "/healthz");
    assert.equal(h1.status, 200, h1.body);
    assert.ok(await b.waitFor(/PRELOAD-REJECTED/, 60000), "the rejection was made:\n" + b.err().slice(-2000));
    assert.match(b.err(), /^\[site\] unhandled rejection \(kept running\): HTTP 401 \{"error":"Unauthorized"\} @ at /m);
    const h2 = await get(b.port, "/healthz");
    assert.equal(h2.status, 200, "still serving after the rejection: " + h2.body);
    assert.match(h2.body, /"ok":true/);
    fs.writeFileSync(path.join(b.dir, "throw-now"), "1");
    const r = await b.exitWithin(30000);
    assert.ok(r, "an uncaught exception ends it");
    assert.equal(r.code, 1);
    assert.match(b.err(), /^\[site\] uncaught exception - exiting: HTTP 401 \{"error":"Unauthorized"\} @ at /m);
    assert.doesNotMatch(b.out() + b.err(), FAKE);
  } finally { await b.cleanup(); }
});

// ── source ──
test("source: index.js installs the guard as its FIRST statement (before every other require) and calls ready() when it listens", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const GUARD = 'require("./processguard").guardProcess(process, { label: "site", bootFatal: true });';
  const first = src.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//"));
  assert.equal(first, GUARD, "the first statement");
  const at = src.indexOf(GUARD);
  const reqs = [...src.matchAll(/require\(\s*["'][^"']+["']\s*\)/g)].filter((m) => !/processguard/.test(m[0]));
  assert.ok(reqs.length > 100);
  assert.ok(reqs.every((m) => m.index > at), "every other require comes after it");
  assert.ok(at < src.indexOf("UV_THREADPOOL_SIZE") && at < src.indexOf("setTimeout(") && at < src.indexOf("new sqlite3.Database("));
  assert.equal(src.split(GUARD).length, 2, "installed once");
  const listen = src.indexOf('require("./listen").listen(app, port, "site", () => {');
  const ready = src.indexOf('require("./processguard").ready(process);');
  const end = src.indexOf("});", listen);
  assert.ok(listen > 0 && ready > listen && ready < end, "ready() inside the listen callback");
  assert.doesNotMatch(src, /process\.(on|once|addListener|prependListener)\(\s*["'](unhandledRejection|uncaughtException)/);
});

test("source: nothing else in the site / bots installs its own unhandledRejection / uncaughtException / warning handler", () => {
  // tools/ and deploy/ are separate processes (and test/ their tests); public/ + views/ run in browsers; runtime data folders and
  // the private Pepe checkout some machines nest here (camfrog-bot/, .gitignored - any nested repo) aren't the site's code
  const skip = new Set(["node_modules", "public", "views", "uploads", "fileupload", "backups", "media", "test", "tools", "deploy", "ci",
                        "docs", "data", "locales", "camfrog-bot"]);
  const hits = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        const sub = path.join(d, ent.name);
        if (!skip.has(ent.name) && !ent.name.startsWith(".") && !fs.existsSync(path.join(sub, ".git"))) walk(sub);
        continue;
      }
      if (!ent.name.endsWith(".js")) continue;
      const f = path.join(d, ent.name), s = fs.readFileSync(f, "utf8");
      // any emitter (process, proc, ...) - an event name that only a process emits
      if (/\.(on|once|addListener|prependListener|prependOnceListener)\(\s*["'](unhandledRejection|uncaughtException|uncaughtExceptionMonitor)["']|process\.(on|once|addListener|prependListener|prependOnceListener)\(\s*["']warning["']|setUncaughtExceptionCaptureCallback/.test(s)) {
        hits.push(path.relative(repo, f).replace(/\\/g, "/"));
      }
    }
  })(repo);
  assert.deepEqual(hits, ["processguard.js"]);
  const srv = fs.readFileSync(path.join(repo, "server.js"), "utf8");
  assert.match(srv, /CP\.guardProcess\(process\);/, "server.js keeps its guard (through channelpoints.js)");
});
