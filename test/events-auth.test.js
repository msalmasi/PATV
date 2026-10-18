// 1.99acf eventsauth.js: who may listen on the /events bus (the chat design §16). Observe (default) serves everyone and counts
// anon / session / key / mismatch; enforce needs the spin owner's session or a bot key for spin / results channels (another
// member -> 403, nobody -> 401), binds a gold-wheel page channel to "<userId>:<pageId>", keeps public / watch open but
// non-identifying (the OBS request without a username but with its spin id; the homepage line without a spin id and
// "someone" for an incognito spinner), leaves dm to messages.sse and refuses anything else (400). index.js wiring checked.
//   node --test test/events-auth.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "events-auth-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bk = require(path.join(repo, "botkeys"));
const EA = require(path.join(repo, "eventsauth"));
const I = require(path.join(repo, "incognito"));

bk._setArgon({ t: 1, m: 64, p: 1 });
require(path.join(repo, "opsalerts")).alert = async () => ({});
const ACTOR = { userId: "u-owner", username: "owner" };
const SPIN = crypto.randomUUID();
let base, server, KEY;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE wheel_spins (spinId TEXT PRIMARY KEY, userId TEXT, type TEXT, result TEXT, transactionId TEXT)");
  await runQuery("INSERT INTO users (userId, username, password, camfrogUsername) VALUES ('u-ann', 'ann', 'x', 'AnnCF'), ('u-bob', 'bob', 'x', NULL)");
  await runQuery("INSERT INTO wheel_spins (spinId, userId, type, result) VALUES (?, 'u-ann', 'public', 'INTENT')", [SPIN]);
  await bk.init(); await EA.init(); await I.init();
  KEY = (await bk.mint("twitch", "Twitch bot", ACTOR)).key;
  const app = express();
  app.use((req, res, next) => { const u = req.get("x-test-session"); if (u) req.loginSession = { id: "sess-" + u, userId: u }; next(); });
  app.use(bk.middleware);
  app.get("/events", async (req, res) => res.json(await EA.decide(req, req.query.type, req.query.identifier)));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const ask = async (type, identifier, { user, key } = {}) => {
  const r = await fetch(`${base}/events?type=${type}&identifier=${encodeURIComponent(identifier)}`,
                        { headers: Object.assign({}, user ? { "x-test-session": user } : {}, key ? { "x-patv-key": key } : {}) });
  return r.json();
};

test("observe: everyone is served as today, and the auth kind is counted", async () => {
  const cases = [
    [["results", SPIN, {}], "anon"], [["results", SPIN, { user: "u-ann" }], "session"], [["results", SPIN, { user: "u-bob" }], "mismatch"],
    [["results", SPIN, { key: KEY }], "key"], [["spin", "public", {}], "anon"], [["spin", "watch", { user: "u-bob" }], "session"],
    [["spin", "k3j4h5g6f7", { user: "u-ann" }], "session"],
  ];
  for (const [[type, id, o], auth] of cases) {
    const d = await ask(type, id, o);
    assert.equal(d.ok, true, `${type}/${id}`);
    assert.equal(d.auth, auth, `${type}/${id} ${JSON.stringify(o)}`);
    assert.equal(d.register, id, "registered under the identifier, as today");
  }
  await bk.flush();
  const log = await getQuery("SELECT type, chan, auth, n FROM events_auth_log");
  const n = (type, chan, auth) => (log.find((r) => r.type === type && r.chan === chan && r.auth === auth) || { n: 0 }).n;
  assert.equal(n("results", "results", "mismatch"), 1);
  assert.equal(n("results", "results", "key"), 1);
  assert.equal(n("spin", "public", "anon"), 1);
  assert.equal(n("spin", "page", "session"), 1);
});

test("enforce: spin / results need the owner's session or a key; a page binds to <userId>:<pageId>; public / watch stay open", async () => {
  await bk.setSettings({ events: "enforce" }, ACTOR);
  assert.equal((await ask("results", SPIN, { user: "u-ann" })).ok, true, "the spinner");
  assert.equal((await ask("results", SPIN, { key: KEY })).ok, true, "a bot with its key");
  assert.equal((await ask("spin", SPIN, { key: KEY })).ok, true);
  let d = await ask("results", SPIN, { user: "u-bob" });
  assert.deepEqual([d.ok, d.status], [false, 403], "someone else's spin");
  d = await ask("results", SPIN, {});
  assert.deepEqual([d.ok, d.status], [false, 401], "nobody");
  d = await ask("results", crypto.randomUUID(), { user: "u-ann" });
  assert.deepEqual([d.ok, d.status], [false, 403], "a spin id that isn't yours (or doesn't exist)");
  d = await ask("spin", "k3j4h5g6f7", { user: "u-ann" });
  assert.deepEqual([d.ok, d.register], [true, "u-ann:k3j4h5g6f7"], "the gold-wheel page channel is bound to the signed-in member");
  d = await ask("spin", "k3j4h5g6f7", {});
  assert.deepEqual([d.ok, d.status], [false, 401]);
  assert.equal((await ask("spin", "public", {})).ok, true);
  assert.equal((await ask("spin", "watch", {})).ok, true);
  assert.equal((await ask("dm", "", {})).ok, true, "dm: messages.sse decides");
  d = await ask("bogus", "x", { user: "u-ann" });
  assert.deepEqual([d.ok, d.status], [false, 400]);
  await bk.setSettings({ events: "observe" }, ACTOR);
});

test("public views: the OBS request has no username (keeps the spin id), the homepage line no spin id; an incognito spinner is anonymous in BOTH modes", async () => {
  const req = { message: "Request: ann", spinId: SPIN, timestamp: "t" };
  const watch = { type: "spinning", spinId: SPIN, name: "ann", display: "Ann", nameCss: "color:red" };
  assert.deepEqual(EA.publicView("public", req), req, "observe: unchanged");
  assert.deepEqual(EA.publicView("watch", watch), watch);
  await bk.setSettings({ events: "enforce" }, ACTOR);
  const p = EA.publicView("public", req);
  assert.deepEqual(p, { message: "Request", spinId: SPIN, timestamp: "t" });
  assert.ok(p.message.includes("Request") && p.spinId, "what the OBS page tests for");
  assert.deepEqual(EA.publicView("watch", watch), { type: "spinning", name: "ann", display: "Ann", nameCss: "color:red" });
  const look = { name: "ann", display: "Ann", nameCss: "color:red" };
  assert.deepEqual(await EA.watchLook("u-ann", look), look, "not incognito: the look");
  await I.sync({ items: [{ login: "anncf", on: true, via: "chat", ts: Date.now() }] });
  const anon = { name: "", display: "", nameCss: "", anon: true };
  assert.deepEqual(await EA.watchLook("u-ann", look), anon, "incognito: anon, no name, no colour (the page says 'someone' in its language)");
  await runQuery(`INSERT INTO incognito_state (login, "on", updated) VALUES ('u:u-bob', 1, 1)`);
  assert.equal(await EA.isIncognito("u-bob"), true, "an account key counts too");
  await bk.setSettings({ events: "observe" }, ACTOR);
  assert.deepEqual(await EA.watchLook("u-ann", look), anon, "observe too: an incognito spinner is never named on a public surface");
  assert.ok(!JSON.stringify(await EA.watchLook("u-ann", look)).includes("ann"), "nothing of the name left");
});

test("the log is bounded: any ?type= counts as dm | spin | results | other, at most MAX_KEYS rows between flushes; /admin/keys reads at most 500", async () => {
  await bk.flush();
  await runQuery("DELETE FROM events_auth_log");
  for (let i = 0; i < 25; i++) await ask("rnd" + crypto.randomBytes(4).toString("hex"), "x");
  await ask("results", SPIN, {});
  await bk.flush();
  const rows = await getQuery("SELECT type, chan, auth, n FROM events_auth_log ORDER BY type");
  assert.deepEqual(rows.map((r) => r.type), ["other", "results"], "random types collapse into 'other'");
  assert.equal(rows.find((r) => r.type === "other").n, 25);
  assert.ok(EA.TYPES.every((t) => ["dm", "spin", "results"].includes(t)));
  // the in-memory map can't grow past MAX_KEYS between two flushes (new keys are dropped, existing ones still count)
  const C = EA._counts();
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < EA.MAX_KEYS + 50; i++) C.set(day + "\u0001fill" + i + "\u0001x\u0001anon", 1);
  const size = C.size;
  await ask("spin", "public", {});
  assert.equal(EA._counts().size, size, "a new key past the cap is dropped");
  for (const k of [...C.keys()]) if (k.includes("fill")) C.delete(k);
  await runQuery("DELETE FROM events_auth_log");
  const stmts = [];
  for (let i = 0; i < 600; i++) stmts.push(runQuery("INSERT INTO events_auth_log (day, type, chan, auth, n) VALUES (?, ?, ?, ?, 1)", [day, "other", "c" + i, "anon"]));
  await Promise.all(stmts);
  assert.equal((await EA.recent(7)).length, 500, "recent() has a LIMIT");
});

test("index.js: /events asks eventsauth first, registers under its answer, the public sends go through publicView, gold spins go to both names", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const route = src.slice(src.indexOf('app.get("/events"'), src.indexOf("function registerClient"));
  assert.match(route, /await eventsAuth\.decide\(req, type, identifier\)/);
  assert.ok(route.indexOf("eventsAuth.decide") < route.indexOf('if (type === "dm") return messages.sse(req, res)'), "counted before dm");
  assert.match(route, /registerClient\(type, chan, res\)/);
  assert.ok(!/console\.log/.test(route), "the identifier is no longer logged");
  assert.match(src, /message = eventsAuth\.publicView\(identifier, message\)/);
  assert.match(src, /sendEvent\("spin", `\$\{user\[0\]\.userId\}:\$\{pageId\}`, goldMsg\)/);
  assert.equal((src.match(/eventsAuth\.watchLook\(/g) || []).length, 3, "last.json, acknowledge-spin (stage + OBS answer) and the settle send");
});

test("index.js: an incognito spinner never appears in /api/g/wheel/last.json or the open acknowledge-spin answer", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const last = src.slice(src.indexOf('app.get("/api/g/wheel/last.json"'), src.indexOf('app.get("/api/g/wheel/last-result"'));
  assert.match(last, /await eventsAuth\.watchLook\(r\.userId, await spinnerLook\(r\.userId\)\)/, "last.json goes through watchLook");
  assert.ok(!/\}, await spinnerLook\(r\.userId\)\) \}\)/.test(last), "never the raw look");
  const ack = src.slice(src.indexOf('app.post("/api/g/acknowledge-spin"'), src.indexOf("// Prune pending/unresolved spins."));
  assert.match(ack, /const look = await eventsAuth\.watchLook\(spinDetails\[0\]\.userId, await spinnerLook\(spinDetails\[0\]\.userId\)\)/);
  assert.match(ack, /spinner: look,/);
  assert.match(ack, /message: ackMessage,/, "the answer's message is built from the filtered look");
  assert.match(ack, /look\.anon \? `public spinid \$\{spinId\} from someone`/, "an incognito spinner's name never rides the message");
  assert.match(ack, /eventsAuth\.enforcing\(\) \? `public spinid \$\{spinId\}`/, "enforce: no username in the open answer at all");
  assert.ok(!/message: `public spinid \$\{spinId\} from \$\{username\}`,\s*spinner/.test(ack), "the old message is gone from the answer");
  // the pages render {anon:true} as 'someone' (the homepage in its own language)
  const home = fs.readFileSync(path.join(repo, "views", "home.ejs"), "utf8");
  assert.match(home, /sp\.anon \? _t\('js\.home\.spin\.someone', 'someone'\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"))["js.home.spin.someone"], "someone");
  const obs = fs.readFileSync(path.join(repo, "public", "publicwheel.js"), "utf8");
  assert.match(obs, /data\.spinner && data\.spinner\.anon \? 'someone'/);
});
