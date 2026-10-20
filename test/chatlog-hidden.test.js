// CL2 chatlog.js: the STICKY hidden set (the privacy critique's B1 - Pepe's hidden_h used to fail open). An empty list, a list
// missing one hash and a 3,001-entry list un-hide nobody; a website Incognito ON hides at once, before Pepe answers (the linked
// account's own earlier web lines too); a privacy.shown removes only the reason it names (CL2 fix-up: !bridge hide and
// incognito are kept apart - a lost bridge file can't let !incognito off un-hide a !bridge hide; a hash only a list named stays
// until both kinds are un-hidden); an un-hide never undoes a NEWER hide (a stale event in Pepe's queue, a held batch approved
// later); a mass weakening is held for an operator (approve / reject); src forget / delete / staff survive Pepe's un-hides;
// u:<id> keys hash the same on both sides (lower-cased); an incognito OFF report un-hides nothing; !transcripts off (scope tx,
// tx_hidden_h add-only); chatlog_private_ever only grows; privacy events are at-least-once (a failed write -> Pepe re-sends);
// the set is loaded at boot (a fresh process sees it), every key counts as hidden until it is, and an older table gains its
// reasons column.
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-hidden.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-hidden-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const CL = require(path.join(repo, "chatlog"));
const bridge = require(path.join(repo, "bridge"));
const I = require(path.join(repo, "incognito"));

// Pepe's own hash (pepe_bridge._br_hidden_hashes): sha256("pepe-hidden:" + login) of the lower-cased login
const pepeHash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).toLowerCase(), "utf8").digest("hex").slice(0, 20);
const set = async (table = "chatlog_hidden") => (await getQuery(`SELECT h FROM ${table} ORDER BY h`)).map((r) => r.h);
const ever = async () => (await getQuery("SELECT h FROM chatlog_private_ever ORDER BY h")).map((r) => r.h);
let seq = 0;
// a privacy event as Pepe CL1 sends it; ts = when Pepe queued it (default: stamped by sync(), after everything before it)
const pev = (type, h, scope, ts) => ({ op: "event", id: "priv-" + (++seq), ...(ts ? { ts: new Date(ts).toISOString() } : {}), type, data: { h, scope } });
const hide = (login, scope, ts) => pev("privacy.hidden", pepeHash(login), scope, ts);
const show = (login, scope, ts) => pev("privacy.shown", pepeHash(login), scope, ts);
// a millisecond or two: an un-hide removes only reasons no newer than itself, and an event's time is never later than now
const tick = () => new Promise((r) => setTimeout(r, 3));
// a bridge sync carrying only privacy state (what Pepe CL1 sends): events + hidden_h (+ tx_hidden_h); events are awaited by
// ingest itself, a list-only sync is not - wait() queues behind it (the set's updates are serial)
async function sync(list, events = [], extra = {}) {
  await tick();
  const t = new Date().toISOString();
  for (const e of events) if (!e.ts) e.ts = t;
  await bridge.ingest({ events, rooms: [], hidden_h: list, ...extra });
  await wait();
}
const wait = () => CL.noteSync({ list: [] });
const pending = async () => getQuery("SELECT id, kind, hs FROM chatlog_hidden_held WHERE state = 'pending' ORDER BY id");

// (a promise every test awaits - Node 16's runner doesn't wait for a top-level test.before)
const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  require(path.join(repo, "actions"));
  require(path.join(repo, "inbox"));
  await I.init();
  await CL.init();
  await bridge.load();
})();

test("Pepe's lists only ADD: [], a list missing a hash and a 3,001-entry list un-hide nobody", async () => {
  await setup;
  const a = pepeHash("alice"), b = pepeHash("bob");
  await sync([a, b]);
  assert.deepEqual(await set(), [a, b].sort());
  assert.ok(CL.isHiddenKey("Alice"), "keys are lower-cased");
  assert.deepEqual(CL.hiddenReasons(a), ["list_b", "list_i"], "a list doesn't say why: both kinds");
  assert.equal(CL.hiddenKind(a), "out", "an unknown kind is left out");
  await sync([]);
  await sync([a]);
  const big = Array.from({ length: 3001 }, (_, i) => pepeHash("filler" + i));
  await sync(big);
  assert.ok(CL.isHiddenKey("alice") && CL.isHiddenKey("bob"), "still hidden");
  assert.equal((await set()).length, 3003);
  assert.equal(CL.hiddenCount().hidden, 3003);
  await sync(null);                                     // not a list (an old Pepe): ignored
  await sync("nope");
  assert.equal(CL.hiddenCount().hidden, 3003);
  assert.deepEqual((await ever()).length, 3003, "every hash also in chatlog_private_ever");
});

test("a website Incognito ON hides at once, before Pepe answers (the account's earlier web lines too); OFF un-hides nothing; Pepe's un-hide shows both", async () => {
  await setup;
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u_carol', 'carol', 'Carol', 'x', 'Carol_CF')");
  assert.equal(CL.isHiddenKey("carol_cf"), false);
  await I.request("u_carol", true, {});
  assert.equal(CL.isHiddenKey("carol_cf"), true, "hidden before Pepe ran the action");
  assert.equal(CL.isHiddenKey("u:u_carol"), true, "her web lines from before she linked (said as u:<userId>)");
  assert.deepEqual(CL.hiddenReasons(pepeHash("u:u_carol")), ["of:" + pepeHash("carol_cf")]);
  const row = (await getQuery("SELECT src FROM chatlog_hidden WHERE h = ?", [pepeHash("carol_cf")]))[0];
  assert.equal(row.src, "web");
  assert.equal(CL.hiddenKind(pepeHash("carol_cf")), "anon", "incognito: anonymised, not left out (the owner's decision-9 change)");
  await I.request("u_carol", false, {});
  assert.equal(CL.isHiddenKey("carol_cf"), true, "only Pepe's un-hide un-hides");
  await sync([], [show("carol_cf", "incognito")]);
  assert.equal(CL.isHiddenKey("carol_cf"), false, "Pepe's privacy.shown {incognito}");
  assert.equal(CL.isHiddenKey("u:u_carol"), false, "...shows her earlier web lines again too");
});

test("privacy.shown removes only the reason it names: !incognito off can't un-hide a !bridge hide (nor the other way round)", async () => {
  await setup;
  const d = pepeHash("dave");
  await sync([d], [hide("dave", "bridge"), hide("dave", "incognito")]);
  assert.deepEqual(CL.hiddenReasons(d), ["bridge", "incognito"], "the list added nothing: the events said why");
  // Pepe's bridge file was lost (his !bridge hide list starts empty): his !incognito off then says nothing hides dave any more
  await sync([], [show("dave", "incognito")]);
  assert.equal(CL.isHiddenKey("dave"), true, "still !bridge hide");
  assert.equal(CL.hiddenKind(d), "out");
  await sync([], [show("dave", "bridge")]);
  assert.equal(CL.isHiddenKey("dave"), false, "both un-hidden");
  assert.ok((await ever()).includes(d), "chatlog_private_ever never shrinks");
  await sync([], [hide("erin", "bridge")]);
  await sync([], [pev("privacy.shown", pepeHash("erin"), "nonsense")]);       // an un-hide without a known scope: ignored (fail closed)
  assert.equal(CL.isHiddenKey("erin"), true);
  await tick();
  const t = Date.now();
  await sync([], [hide("dave", "bridge", t), show("dave", "bridge", t)]);      // the same time, in order: the last one wins
  assert.equal(CL.isHiddenKey("dave"), false);
  await sync([], [show("dave", "bridge", t + 1), hide("dave", "bridge", t + 1)]);
  assert.equal(CL.isHiddenKey("dave"), true);
  await sync([], [show("dave", "bridge")]);
  assert.equal(CL.isHiddenKey("dave"), false);
  // the same sync's list still lists the hash after its un-hide: it is hidden again (a list never removes, and re-adds)
  await sync([pepeHash("dave")], [hide("dave", "bridge"), show("dave", "bridge")]);
  assert.equal(CL.isHiddenKey("dave"), true);
});

test("the review's scenario C: a list-only hash (hidden before CL1, kind unknown) survives an incognito OFF report, an empty list and a lone privacy.shown", async () => {
  await setup;
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u_both', 'both', 'Both', 'x', 'bothcf')");
  await sync([pepeHash("bothcf")]);
  await I.sync({ items: [{ login: "bothcf", on: false, via: "chat", ts: Date.now() }] });
  await sync([]);                                       // Pepe's bridge file failed to load: his list lost them
  assert.equal(CL.isHiddenKey("bothcf"), true, "[] un-hides nobody, whatever was reported");
  await sync([], [show("bothcf", "incognito")]);
  assert.equal(CL.isHiddenKey("bothcf"), true, "an incognito un-hide can't speak for a !bridge hide the site was never told about");
  assert.deepEqual(CL.hiddenReasons(pepeHash("bothcf")), ["list_b"]);
  await sync([], [show("bothcf", "bridge")]);
  assert.equal(CL.isHiddenKey("bothcf"), false, "both kinds un-hidden");
  // a hide Pepe's list showed before its event arrived: the event says what it was (no leftover unknown kind)
  await sync([pepeHash("newbie")]);
  await sync([pepeHash("newbie")], [hide("newbie", "incognito", Date.now() - 2000)]);
  assert.deepEqual(CL.hiddenReasons(pepeHash("newbie")), ["incognito"]);
  await sync([], [show("newbie", "incognito")]);
  assert.equal(CL.isHiddenKey("newbie"), false);
});

test("the review's scenario B: a stale privacy.shown still in Pepe's queue never undoes a newer website ON", async () => {
  await setup;
  const t = Date.now();
  await CL.hideNow(["webby"], "web");
  await sync([], [show("webby", "incognito", t - 5000)]);           // queued by an earlier !incognito off, delivered late
  assert.equal(CL.isHiddenKey("webby"), true);
  await sync([], [show("webby", "bridge")]);                          // the other kind never touches it
  assert.equal(CL.isHiddenKey("webby"), true);
  // Pepe confirms the ON (his own incognito reason replaces the website's), then a real !incognito off
  await sync([], [hide("webby", "incognito")]);
  assert.deepEqual(CL.hiddenReasons(pepeHash("webby")), ["incognito"]);
  await sync([], [show("webby", "incognito")]);
  assert.equal(CL.isHiddenKey("webby"), false);
  // a future-dated event (a fast clock) is taken as now - it can't outrun the website's next ON
  await sync([], [show("webby2", "incognito", Date.now() + 3600e3)]);
  await tick();
  await CL.hideNow(["webby2"], "web");
  await sync([], [show("webby2", "incognito", Date.now() - 1000)]);
  assert.equal(CL.isHiddenKey("webby2"), true);
});

test("a mass weakening is held for an operator; approve applies it, reject keeps them; a hide after the hold survives the approve (scenario A)", async () => {
  await setup;
  const ks = Array.from({ length: 6 }, (_, i) => "mass" + i);
  await sync([], ks.map((k) => hide(k, "bridge")));
  await sync([], ks.map((k) => show(k, "bridge")));
  for (const k of ks) assert.equal(CL.isHiddenKey(k), true, "held, not applied");
  let held = await pending();
  assert.equal(held.length, 1);
  assert.equal(held[0].kind, "shown");
  assert.equal(JSON.parse(held[0].hs).length, 6);
  const v = await CL.adminView();
  assert.equal(v.held[0].n, 6);
  // mass3 runs !bridge hide again while the batch waits
  await sync([], [hide("mass3", "bridge")]);
  await assert.rejects(CL.decideHeld(999999, true), (e) => e.code === "not_found");
  const r = await CL.decideHeld(held[0].id, true, "admin");
  assert.deepEqual(r, { removed: 5, weakened: 5 });
  for (const k of ks) assert.equal(CL.isHiddenKey(k), k === "mass3", k);
  await assert.rejects(CL.decideHeld(held[0].id, true), (e) => e.code === "decided");
  // left out -> anonymised counts too: six people !bridge hide AND incognito, then !bridge show
  const both = Array.from({ length: 6 }, (_, i) => "two" + i);
  await sync([], both.flatMap((k) => [hide(k, "bridge"), hide(k, "incognito")]));
  await sync([], both.map((k) => show(k, "bridge")));
  assert.ok(both.every((k) => CL.hiddenKind(pepeHash(k)) === "out"), "held");
  held = await pending();
  assert.deepEqual(await CL.decideHeld(held[0].id, true, "admin"), { removed: 0, weakened: 6 });
  assert.ok(both.every((k) => CL.hiddenKind(pepeHash(k)) === "anon"), "still incognito");
  // the percentage rule: 2+ that are over 10 % of a small set are held too; a single explicit un-hide never is
  await sync([], [hide("p1", "bridge")]);
  await sync([], [show("p1", "bridge")]);
  assert.equal(CL.isHiddenKey("p1"), false, "one at a time goes through");
  assert.equal((await pending()).length, 0);
  // exactly HOLD_N of a set of thousands: under both limits, applied
  const five = Array.from({ length: CL.HOLD_N }, (_, i) => "q" + i);
  await sync([], five.map((k) => hide(k, "bridge")));
  await sync([], five.map((k) => show(k, "bridge")));
  for (const k of five) assert.equal(CL.isHiddenKey(k), false);
  assert.equal((await pending()).length, 0);
  // reject
  const rs = Array.from({ length: 7 }, (_, i) => "rej" + i);
  await sync([], rs.map((k) => hide(k, "bridge")));
  await sync([], rs.map((k) => show(k, "bridge")));
  const h4 = (await pending())[0];
  assert.deepEqual(await CL.decideHeld(h4.id, false, "admin"), { removed: 0, weakened: 0 });
  assert.ok(rs.every((k) => CL.isHiddenKey(k)));
});

test("forget / delete / staff entries survive Pepe's un-hides (and upgrade a pepe entry)", async () => {
  await setup;
  await CL.hideNow(["frank"], "forget");
  await CL.hideNow(["gina"], "pepe");
  await CL.hideNow(["gina"], "delete");
  assert.equal((await getQuery("SELECT src FROM chatlog_hidden WHERE h = ?", [pepeHash("gina")]))[0].src, "delete", "upgraded");
  await CL.hideNow(["gina"], "pepe");
  assert.equal((await getQuery("SELECT src FROM chatlog_hidden WHERE h = ?", [pepeHash("gina")]))[0].src, "delete", "never downgraded");
  await sync([], [show("frank", "bridge"), show("gina", "incognito"), show("gina", "bridge")]);
  assert.equal(CL.isHiddenKey("frank"), true);
  assert.equal(CL.isHiddenKey("gina"), true);
  assert.deepEqual(CL.hiddenReasons(pepeHash("gina")), ["delete"]);
});

test("u:<userId> keys hash the same on both sides (lower-cased)", async () => {
  await setup;
  const key = "u:3F2504E0-4F89-11D3-9A0C-0305E82C3301";
  await sync([pepeHash(key)]);                            // Pepe hashes the lower-cased key
  assert.equal(CL.isHiddenKey(key), true);
  assert.equal(CL.isHiddenKey(key.toLowerCase()), true);
  assert.equal(CL.hash(key), pepeHash(key));
  assert.equal(CL.hash(" " + key + " "), require(path.join(repo, "hubhidden")).hash(key), "the hub's hash too");
});

test("Pepe's incognito reports: ON hides (the linked account's key too), OFF un-hides nothing - only privacy.shown does; the full list only adds", async () => {
  await setup;
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u_hal', 'hal', 'Hal', 'x', 'halcf')");
  await I.sync({ items: [{ login: "halcf", on: true, via: "chat", ts: Date.now() }] });
  assert.equal(CL.isHiddenKey("halcf"), true, "an ON report hides");
  assert.deepEqual(CL.hiddenReasons(pepeHash("halcf")), ["incognito"]);
  assert.equal(CL.isHiddenKey("u:u_hal"), true, "his account key's web lines too");
  await I.sync({ items: [{ login: "halcf", on: false, via: "chat", ts: Date.now() + 1 }] });
  await sync([]);
  assert.equal(CL.isHiddenKey("halcf"), true, "a report and an empty list can't tell whether !bridge hide still hides him");
  await sync([], [show("halcf", "incognito")]);
  assert.equal(CL.isHiddenKey("halcf"), false);
  assert.equal(CL.isHiddenKey("u:u_hal"), false);
  // an unlinked login's reports change nothing but adding; Pepe's full list only adds
  await sync([pepeHash("stranger")]);
  await I.sync({ items: [{ login: "stranger", on: false, via: "chat", ts: Date.now() + 3 }] });
  await sync([]);
  assert.equal(CL.isHiddenKey("stranger"), true);
  await I.sync({ items: [], full: ["ivy"] });
  assert.equal(CL.isHiddenKey("ivy"), true);
  assert.deepEqual(CL.hiddenReasons(pepeHash("ivy")), ["incognito"]);
  await I.sync({ items: [], full: [] });
  assert.equal(CL.isHiddenKey("ivy"), true, "missing from the full list: still hidden");
});

test("!transcripts off (scope tx): its own table, the same rules; tx_hidden_h only adds", async () => {
  await setup;
  await sync([], [hide("jo", "tx")]);
  assert.equal(CL.isTxHiddenKey("jo"), true);
  assert.equal(CL.isHiddenKey("jo"), false, "the person's chat lines aren't hidden");
  assert.deepEqual(await set("chatlog_tx_hidden"), [pepeHash("jo")]);
  await sync([], [show("jo", "tx")]);
  assert.equal(CL.isTxHiddenKey("jo"), false);
  await CL.hideNow(["kim"], "web", "tx");
  assert.equal(CL.isTxHiddenKey("kim"), true);
  // Pepe CL1's tx_hidden_h: a list, add-only ([] and a short list remove nobody)
  await sync([], [], { tx_hidden_h: [pepeHash("lee")] });
  assert.equal(CL.isTxHiddenKey("lee"), true);
  await sync([], [], { tx_hidden_h: [] });
  assert.equal(CL.isTxHiddenKey("lee"), true);
  await sync([], [show("lee", "tx")]);
  assert.equal(CL.isTxHiddenKey("lee"), false);
  // the percentage rule on a small set: 2 of 4 (over 10 %) in one batch are held; 1 of them alone goes through
  await sync([], ["t1", "t2", "t3"].map((k) => hide(k, "tx")));
  assert.equal(CL.hiddenCount().tx, 4);
  await sync([], ["t1", "t2"].map((k) => show(k, "tx")));
  assert.ok(CL.isTxHiddenKey("t1") && CL.isTxHiddenKey("t2"), "held");
  const h = (await pending())[0];
  assert.equal(h.kind, "shown_tx");
  assert.deepEqual(await CL.decideHeld(h.id, true, "admin"), { removed: 2, weakened: 2 });
  assert.ok(!CL.isTxHiddenKey("t1") && !CL.isTxHiddenKey("t2"));
  await sync([], [show("t3", "tx")]);
  assert.equal(CL.isTxHiddenKey("t3"), false, "a single explicit un-hide is never held by the percentage");
  // scenario A (tx): six !transcripts on are held; tx0 turns them off AGAIN; the approval leaves tx0 hidden
  const six = Array.from({ length: 6 }, (_, i) => "tx" + i);
  await sync([], six.map((k) => hide(k, "tx")));
  await sync([], six.map((k) => show(k, "tx")));
  assert.ok(six.every((k) => CL.isTxHiddenKey(k)), "held");
  await sync([], [hide("tx0", "tx")]);
  const h2 = (await pending())[0];
  assert.deepEqual(await CL.decideHeld(h2.id, true, "admin"), { removed: 5, weakened: 5 });
  assert.equal(CL.isTxHiddenKey("tx0"), true, "the later !transcripts off won");
  assert.ok(six.slice(1).every((k) => !CL.isTxHiddenKey(k)));
});

test("privacy events are at-least-once: a write that fails fails the sync, and Pepe's re-send of the same events applies them", async () => {
  await setup;
  const ev = hide("retry", "bridge");
  await runQuery("ALTER TABLE chatlog_hidden RENAME TO chatlog_hidden_away");
  let failed = false;
  try {
    await bridge.ingest({ events: [ev], rooms: [] });
  } catch (e) { failed = true; } finally {
    await runQuery("ALTER TABLE chatlog_hidden_away RENAME TO chatlog_hidden");
  }
  assert.equal(failed, true, "the sync answers an error (Pepe keeps the events and re-sends them)");
  assert.equal(CL.isHiddenKey("retry"), false, "not applied");
  await bridge.ingest({ events: [ev], rooms: [] });           // the same event id again
  assert.equal(CL.isHiddenKey("retry"), true, "applied on the re-send (its id wasn't kept as seen)");
});

test("the set is loaded at boot: a fresh process hides before Pepe's first sync, and counts every key as hidden until it has loaded", async () => {
  await setup;
  const file = path.join(tmp, "boot-child.js");
  fs.writeFileSync(file, `"use strict";
process.chdir(${JSON.stringify(tmp)});
const CL = require(${JSON.stringify(path.join(repo, "chatlog"))});
const before = [CL.hiddenReady(), CL.isHiddenKey("nobody-at-all"), CL.isTxHiddenKey("nobody-at-all"), CL.hiddenKind("0123456789abcdef0123")];
CL.init().then(() => { console.log("RESULT " + JSON.stringify({ before, after: [CL.hiddenReady(), CL.isHiddenKey("nobody-at-all"), CL.isHiddenKey("alice"),
  CL.isHiddenKey("frank"), CL.isHiddenKey("mass3"), CL.isTxHiddenKey("kim"), CL.hiddenReasons(CL.hash("dave"))] })); process.exit(0); },
  (e) => { console.error(e); process.exit(1); });
`);
  const out = execFileSync(process.execPath, [file], { env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const r = JSON.parse(out.split("\n").find((l) => l.startsWith("RESULT ")).slice(7));
  assert.deepEqual(r.before, [false, true, true, "out"], "fail closed before the load");
  assert.deepEqual(r.after, [true, false, true, true, true, true, ["list_b", "list_i"]], "dave: re-listed after his last un-hide (test 3)");
});

test("Train 3 review fix-up: the held rule counts PEOPLE - a linked member's own !incognito off (login + account key) goes through on a small set; two people's still wait", async () => {
  await setup;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-hidden-people-"));
  const file = path.join(dir, "child.js");
  fs.writeFileSync(file, `"use strict";
process.chdir(${JSON.stringify(dir)});
const CL = require(${JSON.stringify(path.join(repo, "chatlog"))});
const { getQuery } = require(${JSON.stringify(path.join(repo, "dbUtils"))});
const shown = (login) => ({ type: "privacy.shown", ts: new Date().toISOString(), data: { h: CL.hash(login), scope: "incognito" } });
(async () => {
  await CL.init();
  const at = Date.now() - 60000;
  // a small set (6 hashes, 4 people): two linked members (login + their account key, reason of:<h>) and two unlinked
  for (const [l, id] of [["alicecf", "u_alice"], ["bobcf", "u_bob"]]) {
    await CL.hideNow([l], "pepe", "incognito", { at });
    await CL.hideNow(["u:" + id], "web", "bridge", { of: l, at });
  }
  await CL.hideNow(["carolcf", "dancf"], "pepe", "incognito", { at });
  const size = CL.hiddenCount().hidden;
  const one = await CL.noteSync({ events: [shown("alicecf")] });
  const after1 = [CL.isHiddenKey("alicecf"), CL.isHiddenKey("u:u_alice")];
  const two = await CL.noteSync({ events: [shown("carolcf"), shown("dancf")] });
  const after2 = [CL.isHiddenKey("carolcf"), CL.isHiddenKey("dancf")];
  // a linked member with one more person in the same batch: 2 people of a 4-hash set - held
  const three = await CL.noteSync({ events: [shown("bobcf"), shown("carolcf")] });
  const pending = (await getQuery("SELECT kind FROM chatlog_hidden_held WHERE state = 'pending'")).map((r) => r.kind);
  console.log("RESULT " + JSON.stringify({ size, one: one.held, after1, two: two.held, after2, three: three.held, bob: CL.isHiddenKey("bobcf"), pending }));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
`);
  const out = execFileSync(process.execPath, [file], { env: { ...process.env, CHATLOG_DB: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const r = JSON.parse(out.split("\n").find((l) => l.startsWith("RESULT ")).slice(7));
  assert.equal(r.size, 6);
  assert.deepEqual([r.one, r.after1], [0, [false, false]], "one person (2 hashes of 6): applied, not held - the login and the account key both shown");
  assert.deepEqual([r.two, r.after2], [2, [true, true]], "two unlinked people (2 of 6, over 10 %): held, as before");
  assert.equal(r.three, 3, "bob (2 hashes) + carol: two people - held");
  assert.equal(r.bob, true);
  assert.deepEqual(r.pending, ["shown", "shown"]);
});

test("a hidden-set table from before the reasons were kept gains its column; each old row keeps what it meant", async () => {
  await setup;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-hidden-old-"));
  const file = path.join(dir, "child.js");
  fs.writeFileSync(file, `"use strict";
process.chdir(${JSON.stringify(dir)});
const { runQuery } = require(${JSON.stringify(path.join(repo, "dbUtils"))});
(async () => {
  await runQuery("CREATE TABLE chatlog_hidden (h TEXT PRIMARY KEY, since INTEGER NOT NULL, src TEXT NOT NULL)");
  const CLh = require(${JSON.stringify(path.join(repo, "chatlog"))}).hash;
  for (const [k, src] of [["oldpepe", "pepe"], ["oldweb", "web"], ["oldforget", "forget"]]) await runQuery("INSERT INTO chatlog_hidden VALUES (?, 5, ?)", [CLh(k), src]);
  const CL = require(${JSON.stringify(path.join(repo, "chatlog"))});
  await CL.init();
  console.log("RESULT " + JSON.stringify(["oldpepe", "oldweb", "oldforget"].map((k) => CL.hiddenReasons(CL.hash(k)))));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
`);
  const out = execFileSync(process.execPath, [file], { env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(JSON.parse(out.split("\n").find((l) => l.startsWith("RESULT ")).slice(7)), [["list_b", "list_i"], ["web"], ["forget"]]);
});
