// Offline tests for 1.99wa: incognito from the website (incognito.js, Settings → Privacy).
//   - a web change queues Pepe's "privacy.incognito" action for the LINKED login (the same switch as !incognito), audits it,
//     and the state stays Pepe's last report ("waiting") until his report of the change arrives
//   - Pepe's report: linked logins only, older reports ignored, an inbox notice per real change (once), chat changes show too,
//     the full list heals the table
//   - unlinked accounts are refused (and the page offers to link), the per-account rate limit, CSRF / sign-in / bot token
//   NODE_PATH=G:/PATV/node_modules node --test test/incognito.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "incognito-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const I = require(path.join(repo, "incognito"));

let T = Date.now();
I._setClock(() => T);
let base, server;
const users = new Map();
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', 'pleb', ?)`,
                 [id, name, name, o.camfrog === undefined ? name + "cf" : o.camfrog]);
  const x = { userId: id, username: name, class: "pleb" };
  users.set(id, x);
  return x;
}
const H = (x, extra) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, x ? { "x-test-user": x.userId } : {}, extra || {});
async function call(method, url, x, body, extra) {
  const r = await fetch(base + url, { method, headers: H(x, extra), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  let d = null;
  try { d = await r.clone().json(); } catch (e) { d = null; }
  return { status: r.status, d, text: d ? null : await r.text() };
}
const U = {};
const inbox = (uid) => getQuery("SELECT title, body, link, ref FROM inbox WHERE user_id = ? ORDER BY id", [uid]);
const actions = (uid) => getQuery("SELECT id, kind, args, camfrog, status FROM pepe_actions WHERE user_id = ? ORDER BY id", [uid]);
// Pepe: claim + ack an action the way pepe_webact does (time moves on)
async function pepeAnswers(id, ok = true, message = "done") {
  await runQuery("UPDATE pepe_actions SET status = ?, message = ?, updated = ? WHERE id = ?", [ok ? "done" : "failed", message, Date.now(), id]);
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, archived_at INTEGER)`);
  require(path.join(repo, "actions"));
  require(path.join(repo, "inbox"));
  await I.init();
  U.alice = await mkUser("alice");
  U.bob = await mkUser("bob");
  U.nolink = await mkUser("nolink", { camfrog: null });
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  I.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 50));
});
test.after(() => { server.close(); });

test("before Pepe reports: state unknown; the page renders with the switch", async () => {
  const s = await call("GET", "/api/privacy/incognito", U.alice);
  assert.equal(s.status, 200);
  assert.equal(s.d.linked, true);
  assert.equal(s.d.login, "alicecf");
  assert.equal(s.d.on, null, "unknown until Pepe reports");
  const page = await call("GET", "/settings/privacy", U.alice);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="pvInc"/);
  assert.match(page.text, /alicecf/);
  // CL6: "Make Pepe forget me" offers "Also hide my past public chat lines", unticked (privacy-forget.js sends hide_lines)
  assert.match(page.text, /<input type="checkbox" id="pvPfLines" aria-describedby="pvPfLinesHint">/);
  assert.match(page.text, /Also hide my past public chat lines/);
  assert.match(page.text, /href="\/settings\/likeness"/);
  assert.equal((await call("GET", "/settings/privacy", null)).status, 302, "signed out -> login");
});

test("web ON -> Pepe's action for the linked login, waiting until his report, then confirmed + inbox notice", async () => {
  const r = await call("POST", "/api/privacy/incognito", U.alice, { on: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const a = await actions(U.alice.userId);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "privacy.incognito");
  assert.deepEqual(JSON.parse(a[0].args), ["on"]);
  assert.equal(a[0].camfrog, "alicecf", "runs as the linked chat login");
  let s = await call("GET", "/api/privacy/incognito", U.alice);
  assert.ok(s.d.waiting && s.d.waiting.want === true, "waiting for Pepe");
  assert.equal(s.d.on, null, "still Pepe's last report");
  assert.match((await call("GET", "/settings/privacy", U.alice)).text, /Waiting for Pepe/);
  // Pepe ran it and reports (a few seconds later)
  await pepeAnswers(a[0].id, true, "incognito is ON for alicecf");
  T += 5000;
  const created = (await getQuery("SELECT created FROM pepe_actions WHERE id = ?", [a[0].id]))[0].created;
  const sy = await call("POST", "/api/privacy/incognito/sync", null, { password: "bot", items: [{ login: "alicecf", on: true, via: "web", changed: true, ts: created + 2000 }] });
  assert.deepEqual([sy.status, sy.d.applied], [200, 1]);
  s = await call("GET", "/api/privacy/incognito", U.alice);
  assert.equal(s.d.waiting, null);
  assert.equal(s.d.on, true);
  const ib = await inbox(U.alice.userId);
  assert.equal(ib.length, 1);
  assert.match(ib[0].title, /Incognito is on/);
  assert.match(ib[0].body, /Settings → Privacy/);
  assert.equal(ib[0].link, "/settings/privacy");
  // the same report again: one notice
  await call("POST", "/api/privacy/incognito/sync", null, { password: "bot", items: [{ login: "alicecf", on: true, via: "web", changed: true, ts: created + 2000 }] });
  assert.equal((await inbox(U.alice.userId)).length, 1, "a re-sent report files no second notice");
  const log = s.d.log.map((x) => x.kind);
  assert.ok(log.includes("request") && log.includes("applied"), "audited");
});

test("a change in chat shows on the web; older reports are ignored; no notice for a no-change report", async () => {
  T += 60000;
  await call("POST", "/api/privacy/incognito/sync", null, { password: "bot", items: [{ login: "AliceCF", on: false, via: "chat", changed: true, ts: T }] });
  let s = await call("GET", "/api/privacy/incognito", U.alice);
  assert.equal(s.d.on, false, "chat OFF shows on the web");
  const ib = await inbox(U.alice.userId);
  assert.match(ib[ib.length - 1].title, /Incognito is off/);
  assert.match(ib[ib.length - 1].body, /!incognito in chat/);
  const r = await call("POST", "/api/privacy/incognito/sync", null, { password: "bot", items: [{ login: "alicecf", on: true, via: "chat", ts: T - 1000 }] });
  assert.equal(r.d.ignored, 1);
  s = await call("GET", "/api/privacy/incognito", U.alice);
  assert.equal(s.d.on, false, "an older report never wins");
  const n = (await inbox(U.alice.userId)).length;
  await call("POST", "/api/privacy/incognito/sync", null, { password: "bot", items: [{ login: "alicecf", on: false, via: "chat", changed: false, ts: T + 1 }] });
  assert.equal((await inbox(U.alice.userId)).length, n, "no notice when nothing changed");
});

test("Pepe's report: unlinked logins are not stored; the full list heals the table", async () => {
  T += 1000;
  const r = await call("POST", "/api/privacy/incognito/sync", null, { password: "bot", items: [{ login: "strangercf", on: true, ts: T }] });
  assert.equal(r.d.ignored, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM incognito_state WHERE login = 'strangercf'"))[0].n, 0, "never stored");
  await call("POST", "/api/privacy/incognito/sync", null, { password: "bot", items: [], full: ["bobcf", "strangercf"] });
  assert.equal((await call("GET", "/api/privacy/incognito", U.bob)).d.on, true, "bob on from the full list");
  assert.equal((await call("GET", "/api/privacy/incognito", U.alice)).d.on, false);
  await call("POST", "/api/privacy/incognito/sync", null, { password: "bot", items: [], full: [] });
  assert.equal((await call("GET", "/api/privacy/incognito", U.bob)).d.on, false, "off the list -> off");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM incognito_state WHERE login = 'strangercf'"))[0].n, 0);
  assert.equal((await call("POST", "/api/privacy/incognito/sync", null, { password: "nope", items: [] })).status, 403, "bot token");
});

test("a failed action shows as failed, not waiting", async () => {
  T += 1000;
  const r = await call("POST", "/api/privacy/incognito", U.bob, { on: true });
  assert.equal(r.status, 200);
  await pepeAnswers(r.d.id, false, "link your Camfrog name first");
  const s = await call("GET", "/api/privacy/incognito", U.bob);
  assert.equal(s.d.waiting, null);
  assert.ok(s.d.failed);
});

test("unlinked accounts: refused, and the page explains + offers to link", async () => {
  const r = await call("POST", "/api/privacy/incognito", U.nolink, { on: true });
  assert.equal(r.status, 409);
  assert.equal(r.d.code, "unlinked");
  assert.equal((await actions(U.nolink.userId)).length, 0, "nothing queued");
  const s = await call("GET", "/api/privacy/incognito", U.nolink);
  assert.equal(s.d.linked, false);
  const page = await call("GET", "/settings/privacy", U.nolink);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /id="pvInc"/, "no switch without a chat identity");
  assert.match(page.text, /edit#camfrogDiv/, "offers to link one");
});

test("guards: sign-in, same-site fetch, a boolean", async () => {
  assert.equal((await call("POST", "/api/privacy/incognito", null, { on: true })).status, 401);
  assert.equal((await call("GET", "/api/privacy/incognito", null)).status, 401);
  assert.equal((await call("POST", "/api/privacy/incognito", U.alice, { on: true }, { "x-requested-with": "" })).status, 403, "fetch only");
  assert.equal((await call("POST", "/api/privacy/incognito", U.alice, { on: true }, { origin: "https://evil.example" })).status, 403, "cross-site");
  assert.equal((await call("POST", "/api/privacy/incognito", U.alice, { on: "yes" })).status, 400);
});

test("rate limit: RATE_MAX requests an hour per account, then 429 (audited); the window passes", async () => {
  await runQuery("DELETE FROM incognito_log WHERE user_id = ?", [U.alice.userId]);
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE user_id = ?", [U.alice.userId]);
  let last = null;
  for (let i = 0; i < I.RATE_MAX; i++) {
    last = await call("POST", "/api/privacy/incognito", U.alice, { on: i % 2 === 0 });
    assert.equal(last.status, 200, JSON.stringify(last.d));
    await runQuery("UPDATE pepe_actions SET status = 'done' WHERE id = ?", [last.d.id]);   // Pepe keeps up (the 6-open cap is separate)
  }
  const r = await call("POST", "/api/privacy/incognito", U.alice, { on: true });
  assert.equal(r.status, 429);
  assert.equal(r.d.code, "rate");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM incognito_log WHERE user_id = ? AND kind = 'refused'", [U.alice.userId]))[0].n, 1, "refusal audited");
  T += I.RATE_WINDOW_MS + 1000;
  assert.equal((await call("POST", "/api/privacy/incognito", U.alice, { on: true })).status, 200, "allowed again after the window");
});
