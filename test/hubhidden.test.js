// 1.99acm hubhidden.js: Pepe's hidden_h kept for the chat hub - only the difference is written (one transaction), invalid values
// and non-arrays ignored, the per-list cap, calls serialised, the privacy/changed "hh:" trigger rows while hubseam.privacy is on,
// the bridge sync never waits for it.
// 1.99add: the set is STICKY (the chat-history design's rule): an empty, short or truncated list (Pepe's state file failed to load,
// his 3,000 cut) and a failed read on the site un-hide nobody - in the table, for the hub, or in quotes; a restart takes the stored
// set back (boot() before Pepe's first sync); only explicit un-hides remove; an owner's un-hide is audited; held batches.
// 1.99add refix 4 (the final verification; the owner's rule of 2026-10-19 - incognito hides WHO, not WHAT): the set keeps WHY
// (bridge / incognito / unknown rows per hash; the hub's copy carries scope "incognito"); each un-hide takes away its own kind;
// a Pepe that says the kinds resolves an older Pepe's unknown rows; an older Pepe's drop needs TWO whole lists in a row (or his own
// OFF report explaining it); readers hide everyone until the start-up read worked; privacy.shown resends, a late post of an older
// run and an un-hide older than a hide that just arrived are ignored; an ON report always hides (a clock that went back); his full
// incognito list adds the incognito kind; owner look-ups are audited.
//   node --test test/hubhidden.test.js      (uses a temp DB; NODE_PATH=G:/PATV/node_modules for express)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "hubhidden-test-")));
delete process.env.STAGING;
delete process.env.HUB_V1_URL;
process.env.SECRET_KEY = "test-secret";
const D = require(path.join(repo, "dbUtils"));
const { runQuery, getQuery } = D;
const H = require(path.join(repo, "hubhidden"));
const HO = require(path.join(repo, "huboutbox"));
const Q = require(path.join(repo, "quotes"));
const I = require(path.join(repo, "incognito"));
// train2 + cl-site merge: quotes.isHidden (tips, mentions, boost, go-live, the mic stage) is the STRICTER of this set and the pad
// chat archive's (chatlog.js - only Pepe's privacy.shown or an operator un-hides there). These tests are about THIS set's rules,
// so they read its half (what hubhidden handed quotes); the merged rule has its own test at the end.
const QH = Q._hubHidden;

const set = async () => (await getQuery("SELECT h FROM hub_hidden_h ORDER BY h")).map((r) => r.h);
const kept = async () => [...new Set((await getQuery("SELECT h FROM hub_hidden_set ORDER BY h")).map((r) => r.h))];
const kindsDb = async (hh) => (await getQuery("SELECT kind FROM hub_hidden_set WHERE h = ? ORDER BY kind", [hh])).map((r) => r.kind);
const srcOf = async (hh, kind = "incognito") => ((await getQuery("SELECT src FROM hub_hidden_set WHERE h = ? AND kind = ?", [hh, kind]))[0] || {}).src;
const scopeOf = async (hh) => ((await getQuery("SELECT scope FROM hub_hidden_h WHERE h = ?", [hh]))[0] || {}).scope;
const hhRows = async () => (await getQuery("SELECT entity FROM hub_outbox WHERE entity LIKE 'hh:%' ORDER BY id")).map((r) => r.entity);
const reader = (hh) => HO.readers["privacy/changed"]("hh:" + hh);
const h = (i) => String(i).padStart(20, "0").replace(/[^0-9a-f]/g, "a");
let EVN = 0;
// every event gets its own id (Pepe's are unique: a resend carries the same one - see the resend test)
const ev = (type, hh, scope, ts) => ({ op: "event", id: `e-${++EVN}`, type, scope: { platform: "camfrog" }, data: scope === undefined ? { h: hh } : { h: hh, scope },
                                       ...(ts != null ? { ts: new Date(ts).toISOString() } : {}) });
const shown = (hh, scope = "bridge", ts) => ev("privacy.shown", hh, scope, ts);
const hidden = (hh, scope = "bridge", ts) => ev("privacy.hidden", hh, scope, ts);
const sorted = (a) => [...a].sort();
const OWNER = { userId: "own", username: "boss" };
const fillOf = (tag, n) => Array.from({ length: n }, (_, i) => H.hash(tag + i));

/** A clean slate: a fresh process's memory, empty tables and outbox (the switch stays as it is). */
async function fresh() {
  H._reset();
  H._setClock(null);
  Q.setHidden([]);
  for (const t of ["hub_hidden_h", "hub_hidden_set", "hub_hidden_meta", "hub_hidden_held", "hub_outbox"]) await runQuery(`DELETE FROM ${t}`);
}
/** A site restart: the process's memory goes, the tables stay. */
async function restart() {
  H._reset();
  Q.setHidden([]);
  return H.boot();
}
/** Lists of one older Pepe (no tx_hidden_h), 1.5 s apart by his clock (from an hour ago by default - the site never compares his
 *  clock with its own). */
function pepe(start = Date.now() - 3600 * 1000) {
  let t = start;
  const L = (list, session, extra = {}) => { t += 1500; return H.noteSync({ list, session, sent: new Date(t).toISOString(), ...extra }); };
  L.now = () => t;
  return L;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, archived_at INTEGER)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u-alice', 'alice', 'alice', 'x', 'AliceCF')");
  // linked logins (strangercf / newcf are not linked)
  for (const n of ["bob", "carol", "dan", "eve", "x"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", ["u-" + n, n, n, n + "cf"]);
  }
  require(path.join(repo, "actions"));
  require(path.join(repo, "inbox"));
  await I.init();
  await require(path.join(repo, "adminaudit")).init();
  await HO.init();
  await HO.setSettings({ privacy: true });
  // cl-site's merge: quotes read BOTH sticky sets (this one and the pad chat archive's, chatlog.js - fail closed until it is
  // loaded); loaded here and knowing nobody, the archive's set leaves the quote rules to this one
  await require(path.join(repo, "chatlog")).init();
  await new Promise((r) => setTimeout(r, 100));          // actions.js / inbox.js create their tables on load
});

test("the hash is quotes.hiddenHash's; loginHash only for the logins the hub accepts", () => {
  assert.equal(H.hash(" Alice "), Q.hiddenHash("alice"));
  assert.equal(H.loginHash("x$y"), H.hash("x$y"));
  assert.equal(H.loginHash("zoë"), null);
  assert.equal(H.loginHash("a".repeat(41)), null);
  assert.equal(H.loginHash(null), null);
});

test("adds: only the difference is written; a non-array or junk adds nothing; a list without a hash removes nothing; the per-list cap", async () => {
  await fresh();
  assert.deepEqual(await H.note(undefined), { ignored: true });
  assert.deepEqual(await H.note("nope"), { ignored: true });
  assert.deepEqual(await H.noteSync(null), { ignored: true }, "a malformed call never throws (the bridge sync would fail)");
  assert.deepEqual(await H.noteSync({ list: [], events: "x", session: { a: 1 }, sent: ["?"] }), { added: 0, removed: 0 });
  assert.deepEqual(await H.note([h(1), h(2), "XYZ", 5, h(2), "0123456789ABCDEF0123"]), { added: 2, removed: 0 });
  assert.deepEqual(await set(), [h(1), h(2)]);
  const since1 = (await getQuery("SELECT since FROM hub_hidden_h WHERE h = ?", [h(1)]))[0].since;
  assert.deepEqual(await H.note([h(2), h(1)]), { added: 0, removed: 0 }, "same set (any order): nothing written");
  assert.deepEqual(await H.note([h(2), h(3)]), { added: 1, removed: 0 }, "h(3) is added - h(1), missing from the list, stays");
  assert.deepEqual(await set(), [h(1), h(2), h(3)]);
  assert.equal((await getQuery("SELECT since FROM hub_hidden_h WHERE h = ?", [h(1)]))[0].since, since1, "`since` is when v1 first stored it");
  const big = Array.from({ length: H.MAX + 50 }, (_, i) => "b" + i.toString(16).padStart(19, "0"));
  assert.equal((await H.note(big)).added, H.MAX, "at most MAX values from one list");
  assert.equal((await set()).length, H.MAX + 3);
});

test("never fails open: an empty list, a list missing someone, Pepe's 3,000 cut and a failed state load un-hide nobody (table, hub, quotes)", async () => {
  await fresh();
  const people = ["alicecf", "bobcf", "carolcf", "shycf"].map(H.hash);
  assert.deepEqual(await H.note(people), { added: 4, removed: 0 });
  // Pepe's bridge file failed to load (his loader swallows it): !bridge hide is empty, only memory_store's incognito list is left
  const failedLoad = [H.hash("shycf")];
  for (const [list, why] of [[[], "an empty list"], [people.slice(1), "a list missing alice"], [people.slice(0, 2), "a short list"], [failedLoad, "a failed state load"]]) {
    assert.deepEqual(await H.note(list), { added: 0, removed: 0 }, why + ": nobody un-hidden");
  }
  assert.deepEqual(await set(), sorted(people));
  for (const l of ["alicecf", "bobcf", "carolcf", "shycf"]) assert.equal(QH(l) && Q.isLeftOut(l), true, l + " stays left out of quotes");
  // Pepe sorts the hashes and cuts the list at 3,000: the 3,001st person is never un-hidden by it
  const many = Array.from({ length: 3001 }, (_, i) => H.hash("member" + i)).sort();
  await H.note(many);
  assert.deepEqual(await H.note(many.slice(0, 3000)), { added: 0, removed: 0 }, "a truncated list: nobody un-hidden");
  const cur = new Set(await set());
  assert.ok(cur.has(many[3000]) && cur.size === 3005);
  // the hub never heard value false: every hh: row names a hash that is still stored (the reader reports the current state)
  const rows = await hhRows();
  assert.equal(rows.length, 3005, "one row per hash ever added, none for a removal");
  assert.ok(rows.every((e) => cur.has(e.slice(3))));
  assert.equal((await reader(people[0])).value, true);
});

test("a failed read on the site: the write fails, nothing is deleted, and the next sync (even an empty list) writes what was missed", async () => {
  await fresh();
  await H.note([h(1), h(2)]);
  H._forget();                                          // the next write reads the table again
  const orig = D.getQuery;
  D.getQuery = async (sql, params) => { if (/FROM hub_hidden_h/.test(sql)) throw new Error("disk I/O error"); return orig(sql, params); };
  try {
    await assert.rejects(H.note([h(3)]), /disk I\/O error/);
  } finally { D.getQuery = orig; }
  assert.deepEqual(await set(), [h(1), h(2)], "nothing deleted");
  assert.equal(H.isHiddenHash(h(3)), true, "the set in memory has the new hash");
  assert.deepEqual(await H.note([]), { added: 1, removed: 0 }, "the next sync writes the missed hash and removes nobody");
  assert.deepEqual(await set(), [h(1), h(2), h(3)]);
});

test("a site restart: the stored set comes back before anything else - an empty first list un-hides nobody, quotes included", async () => {
  await fresh();
  const shy = H.hash("shycf"), bob = H.hash("bobcf");
  await H.note([shy, bob]);
  H._reset();                                           // the process restarted: memory is empty, the table stays
  Q.setHidden([]);
  assert.equal(H.isHiddenHash(shy), false);
  assert.deepEqual(await H.note([]), { added: 0, removed: 0 }, "Pepe lost his state too: an empty list");
  assert.deepEqual(await set(), sorted([shy, bob]));
  assert.equal(H.isHiddenHash(shy) && H.isHiddenHash(bob), true, "taken back from the table");
  assert.equal(QH("shycf") && QH("BobCF"), true, "quotes get it too");
});

test("explicit un-hide: privacy.shown removes its own kind (and the hub hears it) - an older list's unknown row too once no list of the sync carries the hash; scope tx / no scope do nothing; privacy.hidden adds its kind", async () => {
  await fresh();
  const a = H.hash("alicecf"), b = H.hash("bobcf"), c = H.hash("carolcf");
  assert.deepEqual(await H.noteSync({ events: [hidden(a), hidden(b, "incognito"), hidden(c, "tx"), { type: "message", data: { h: c } }] }), { added: 2, removed: 0 },
                   "privacy.hidden adds; scope tx (!transcripts off) is another set; other events are ignored");
  assert.deepEqual([await set(), await kindsDb(a), await kindsDb(b)], [sorted([a, b]), ["bridge"], ["incognito"]]);
  assert.deepEqual([await scopeOf(a), await scopeOf(b)], [null, "incognito"], "the hub's copy: bob only incognito (shown as someone), alice left out");
  await runQuery("DELETE FROM hub_outbox");
  assert.deepEqual(await H.noteSync({ list: [a, b], events: [shown(a)] }), { added: 0, removed: 0 }, "the same sync's list still carries her: hidden");
  assert.deepEqual([await kindsDb(a), await kindsDb(b)], [["unknown"], ["incognito", "unknown"]], "a mixed list doesn't say why: unknown (left out)");
  assert.deepEqual(await hhRows(), ["hh:" + b], "bob's scope changed for the hub (now left out); nothing went");
  assert.equal((await reader(b)).scope, undefined);
  assert.deepEqual(await H.noteSync({ list: [b], events: [shown(a, "tx"), ev("privacy.shown", a, undefined), shown(a, "nope"), { type: "privacy.shown", data: { h: "XYZ", scope: "bridge" } }] }),
                   { added: 0, removed: 0 }, "an un-hide of another set, or one that doesn't say what it un-hides: nothing (fail closed)");
  assert.equal(H.isHiddenHash(a), true);
  assert.deepEqual(await H.noteSync({ list: [b], events: [shown(a)] }), { added: 0, removed: 1 }, "!bridge show, no list carries her: un-hidden");
  assert.deepEqual(await set(), [b]);
  assert.equal(QH("alicecf"), false, "quotes name her again");
  assert.equal((await reader(a)).value, false, "the hub hears value false - for this explicit un-hide");
  assert.deepEqual(await H.noteSync({ list: [], events: [shown(b, "incognito")] }), { added: 0, removed: 1 }, "!incognito off: no list carries him either");
  const again = shown(a);
  assert.deepEqual(await H.noteSync({ list: [], events: [again] }), { added: 0, removed: 0 }, "Pepe re-sends an event: nothing more happens");
  assert.deepEqual(await H.noteSync({ events: [shown(c), hidden(c)] }), { added: 1, removed: 0 }, "within a sync, the later event wins");
  assert.deepEqual(await set(), [c]);
});

test("refix 4 (the owner's rule): the set keeps WHY - bridge, incognito and unknown rows per hash; left out = bridge or unknown; each un-hide takes away only its own kind (an incognito OFF never undoes !bridge hide); the hub's copy says scope incognito", async () => {
  await freshAll();
  const [ic, br, bo] = ["icf", "brcf", "bothcf"].map(H.hash);
  const t = Date.now() - 60000;
  // a CL1 Pepe that says the kinds: privacy.hidden {scope} and his kinded lists
  await H.noteSync({ list: [ic, br, bo], bridge: [br, bo], incog: [ic, bo], events: [hidden(ic, "incognito"), hidden(br, "bridge")], session: "k1",
                     sent: new Date(t).toISOString(), explicit: true });
  assert.deepEqual([await kindsDb(ic), await kindsDb(br), await kindsDb(bo)], [["incognito"], ["bridge"], ["bridge", "incognito"]]);
  assert.deepEqual([H.isLeftOutHash(ic), H.isLeftOutHash(br), H.isLeftOutHash(bo)], [false, true, true]);
  assert.deepEqual([QH("icf"), Q.isLeftOut("icf"), Q.isLeftOut("brcf"), Q.isLeftOut("bothcf")], [true, false, true, true],
                   "quotes: incognito only = 'someone' with the words; !bridge hide = left out");
  assert.deepEqual([await scopeOf(ic), await scopeOf(br), await scopeOf(bo)], ["incognito", null, null]);
  assert.deepEqual(await reader(ic), { flag: "hidden_h", h: ic, value: true, at: (await getQuery("SELECT since FROM hub_hidden_h WHERE h = ?", [ic]))[0].since, scope: "incognito" });
  const st = H.status();
  assert.deepEqual([st.size, st.left_out, st.anonymised, st.bridge, st.incognito, st.unknown, st.pepe], [3, 2, 1, 2, 2, 0, "kinded"]);
  // an older Pepe's mixed list doesn't say why: unknown - left out, incognito people too (fail closed)
  const x = H.hash("oldcf");
  await H.note([x]);
  assert.deepEqual([await kindsDb(x), H.isLeftOutHash(x)], [["unknown"], true]);
  // both turns incognito OFF (linked or not, changed): only the incognito kind goes - !bridge hide keeps him left out
  await runQuery("DELETE FROM hub_outbox");
  await I.sync({ items: [{ login: "bothcf", on: false, ts: t + 1000, via: "chat" }, { login: "icf", on: false, ts: t + 1000, via: "chat" }] });
  assert.deepEqual([await kindsDb(bo), H.isLeftOutHash(bo), QH("bothcf")], [["bridge"], true, true]);
  assert.deepEqual([H.isHiddenHash(ic), QH("icf")], [false, false], "incognito only: un-hidden at once");
  assert.deepEqual(sorted(await hhRows()), sorted(["hh:" + ic]), "the hub hears ic's un-hide; both's row didn't change (left out either way)");
  // br also turns incognito ON: a second kind - still left out; his !bridge show takes away only bridge: now shown as "someone"
  await I.sync({ items: [{ login: "brcf", on: true, ts: t + 2000, via: "chat" }] });
  assert.deepEqual(await kindsDb(br), ["bridge", "incognito"]);
  await runQuery("DELETE FROM hub_outbox");
  await H.noteSync({ list: [br, bo], bridge: [bo], incog: [br], events: [shown(br, "bridge", t + 3000)], session: "k1", sent: new Date(t + 3000).toISOString(), explicit: true });
  assert.deepEqual([await kindsDb(br), H.isLeftOutHash(br), QH("brcf"), Q.isLeftOut("brcf")], [["incognito"], false, true, false]);
  assert.deepEqual([await hhRows(), await scopeOf(br), (await reader(br)).scope], [["hh:" + br], "incognito", "incognito"], "the hub hears the scope change");
  // an un-hide of a kind the hash doesn't have changes nothing
  await H.noteSync({ list: [br, bo], bridge: [bo], incog: [br], events: [shown(bo, "incognito", t + 4000)], session: "k1", sent: new Date(t + 4000).toISOString(), explicit: true });
  assert.deepEqual(await kindsDb(bo), ["bridge"]);
});

test("refix 4: a Pepe that says the kinds resolves an older Pepe's unknown rows - listed = those kinds, in neither list = held once per run (legacy); one list missing (a failed load) resolves nothing; the member can fix it with !bridge hide, then !bridge show", async () => {
  await freshAll();
  const L = pepe();
  const [p, q, r, s] = ["pcf", "qcf", "rcf", "scf"].map(H.hash);
  await L([p, q, r, s], "o1");                          // the older Pepe: everyone unknown
  assert.equal(H.status().unknown, 4);
  // the upgraded Pepe restarts; his memory store failed to load (incog_hidden_h null): nothing is resolved yet
  await L([p, s], "k1", { bridge: [p], incog: null, explicit: true });
  assert.deepEqual([await kindsDb(p), H.status().held], [["bridge", "unknown"], 0]);
  await L([p, q, s], "k2", { bridge: [p], incog: [q], explicit: true });
  assert.deepEqual([await kindsDb(p), await kindsDb(q)], [["bridge"], ["incognito"]], "his lists account for them");
  assert.equal(H.isLeftOutHash(q), false, "q is incognito only: shown as someone from now on");
  assert.deepEqual([await kindsDb(r), H.isLeftOutHash(r)], [["unknown"], true], "r: in neither list - still left out...");
  assert.deepEqual(H.status().held_batches.map((b) => [b.kind, b.n]), [["legacy", 1]], "...and held once for an owner");
  assert.deepEqual(await kindsDb(s), ["unknown"], "s: his mixed list still carries her, his kinded ones don't: kept (fail closed), not held");
  await L([p, q, s], "k2", { bridge: [p], incog: [q], explicit: true });
  assert.equal(H.status().held_batches.length, 1, "once per run");
  // r fixes it herself: !bridge hide, then !bridge show - no list carries her: every kind goes, the batch is void
  const tt = L.now();
  await L([p, q, r, s], "k2", { bridge: [p, r], incog: [q], explicit: true, events: [hidden(r, "bridge", tt + 100)] });
  await L([p, q, s], "k2", { bridge: [p], incog: [q], explicit: true, events: [shown(r, "bridge", tt + 2000)] });
  assert.deepEqual([H.isHiddenHash(r), QH("rcf"), H.status().held], [false, false, 0]);
});

test("Pepe's incognito reports touch only the incognito kind - an OFF takes it away at once (linked or not, changed or not); an older Pepe's list keeps them left out until it drops them, which their real OFF explains at once; !bridge hide stays; an ON always hides", async () => {
  await freshAll();
  const L = pepe();
  const [al, bo, st, ev2] = ["alicecf", "bobcf", "strangercf", "evecf"].map(H.hash);
  const fill = fillOf("t9f", 30);
  await I.sync({ items: [{ login: "AliceCF", on: true, ts: L.now() - 5000, via: "chat" }, { login: "bobcf", on: true, ts: L.now() - 5000, via: "chat" }] });
  assert.deepEqual([await kindsDb(al), H.isLeftOutHash(al), await srcOf(al)], [["incognito"], false, "report"], "his ON report: incognito - shown as someone");
  await L([al, bo, st, ev2, ...fill], "o1");           // his (older) list carries everyone hidden, mixed: unknown - left out
  assert.deepEqual([await kindsDb(al), H.isLeftOutHash(al), Q.isLeftOut("alicecf")], [["incognito", "unknown"], true, true]);
  const off = L.now() + 100;
  await I.sync({ items: [{ login: "AliceCF", on: false, ts: off, via: "chat" }, { login: "bobcf", on: false, ts: off, via: "chat" },
                         { login: "strangercf", on: false, ts: off, via: "chat" }, { login: "evecf", on: false, ts: off, via: "chat", changed: false }] });
  assert.deepEqual([await kindsDb(al), await kindsDb(bo)], [["unknown"], ["unknown"]], "the incognito kind went at once; his list's word stays");
  assert.equal(QH("alicecf"), true, "still left out until his list drops her");
  assert.deepEqual(await L([bo, ev2, ...fill], "o1"), { added: 0, removed: 2 }, "his next list lacks alice and the stranger: their OFF (between the two lists) explains it - un-hidden at once");
  assert.equal(QH("alicecf") || QH("strangercf"), false);
  assert.equal(QH("bobcf"), true, "bob is on !bridge hide too: still on the list, still left out");
  // eve's no-op OFF explains nothing: her drop needs a second list in a row
  assert.deepEqual(await L([bo, ...fill], "o1"), { added: 0, removed: 0 });
  assert.equal(H.status().absent_once, 1);
  assert.deepEqual(await L([bo, ...fill], "o1"), { added: 0, removed: 1 });
  // a report without a time, or keys that are blank: an ON still hides (fail closed); an OFF of nothing changes nothing
  assert.deepEqual(await H.hiddenReported("nobodycf", null), { added: 1 });
  assert.deepEqual(await H.offReported([null, " "], Date.now()), { removed: 0, ignored: 0 });
});

test("refix 4: an older Pepe (no privacy.shown) un-hides only after TWO whole lists of the same run in a row lack the hash - one short list (a read that failed once) un-hides nobody and the hub hears nothing; a new session, a late or cut list, or a CL1 Pepe never do (review P2)", async () => {
  await fresh();
  const L = pepe();
  const [a, b, c] = ["acf", "bcf", "ccf"].map(H.hash);
  const fill = fillOf("t10f", 20);
  await L([a, b, c, ...fill], "s1");
  await runQuery("DELETE FROM hub_outbox");
  assert.deepEqual(await L([b, c, ...fill], "s1"), { added: 0, removed: 0 }, "one list without her: nothing yet");
  assert.deepEqual([QH("acf"), H.status().absent_once], [true, 1]);
  assert.deepEqual(await L([a, b, c, ...fill], "s1"), { added: 0, removed: 0 }, "back on the next one: a glitch");
  assert.deepEqual([H.status().absent_once, await hhRows()], [0, []], "the hub never heard a thing (no false, then true)");
  await L([b, c, ...fill], "s1");
  assert.deepEqual(await L([b, c, ...fill], "s1"), { added: 0, removed: 1 }, "!bridge show: two lists in a row without her");
  assert.equal(QH("acf"), false, "this set names her again (the merged rule - the archive's set too - has its own test below)");
  assert.equal((await reader(a)).value, false, "the hub hears it");
  assert.deepEqual([H.status().older_unhid, H.status().pepe], [1, "older"]);
  // a list of the same run built earlier (arriving late): compared with nothing - and the next one still sees what it lacked
  const t = L.now();
  assert.deepEqual(await H.noteSync({ list: fill, session: "s1", sent: new Date(t - 5000).toISOString() }), { added: 0, removed: 0 });
  assert.deepEqual([H.status().back, H.status().absent_once], [1, 0]);
  assert.deepEqual(await L([c, ...fill], "s1"), { added: 0, removed: 0 }, "b: absent once (compared with the list before the late one too)");
  assert.deepEqual(await L([c, ...fill], "s1"), { added: 0, removed: 1 }, "...and twice: un-hidden");
  assert.deepEqual(await H.noteSync({ list: fill, session: "s1" }), { added: 0, removed: 0 }, "a list without a time only adds");
  // a list that may be cut (3,000) proves nothing by what it lacks
  const many = Array.from({ length: H.TRUNC }, (_, i) => H.hash("member" + i));
  await L([c, ...many].slice(0, H.TRUNC), "s1");
  await L(many, "s1");
  await L(many, "s1");
  assert.equal(H.isHiddenHash(c), true);
  // a CL1 Pepe (tx_hidden_h) un-hides by privacy.shown only
  await L([c], "s5", { explicit: true });
  await L([], "s5", { explicit: true });
  assert.deepEqual(await L([], "s5", { explicit: true }), { added: 0, removed: 0 });
  assert.deepEqual([H.isHiddenHash(c), H.status().pepe], [true, "explicit"]);
});

test("refix 4: a lasting loss inside one run (his memory store lost the incognito list) un-hides nobody by name once Pepe has said they are incognito (his full list) - their unknown row goes after two lists, the incognito kind keeps them 'someone' (review P2)", async () => {
  await freshAll();
  const L = pepe();
  const logins = Array.from({ length: 60 }, (_, i) => "lost" + i + "cf");
  const big = logins.map(H.hash);
  await L(big, "s2");
  await I.sync({ items: [], full: logins.slice(0, 5) });   // his whole incognito list (every 10 minutes): the first five
  assert.equal(H.status().incognito, 5);
  await L(big.slice(5), "s2");
  assert.deepEqual(await L(big.slice(5), "s2"), { added: 0, removed: 0 }, "5 of 60 lost for good: their unknown rows go (not more than 5, not more than 10 %)...");
  assert.equal(H.status().older_unhid, 5);
  for (const l of logins.slice(0, 5)) assert.deepEqual([QH(l), Q.isLeftOut(l)], [true, false], "...but they stay 'someone', never named");
  // the full list only adds: a login whose OFF arrived just now is not added back by a list built before it
  await I.sync({ items: [{ login: "lost0cf", on: false, ts: Date.now(), via: "chat" }] });
  assert.equal(QH("lost0cf"), false);
  await I.sync({ items: [], full: logins.slice(0, 5) });
  assert.equal(QH("lost0cf"), false, "a full list older than his OFF (posted late) doesn't hide him again");
});

test("an older Pepe's mass drop is a lost state, not people: held (they stay hidden, counted) - 2+ and more than 5 or 10 % of the set, after two lists", async () => {
  await fresh();
  const L = pepe();
  const ps = Array.from({ length: 8 }, (_, i) => H.hash("p" + i));
  await L(ps, "s1");
  await runQuery("DELETE FROM hub_outbox");
  await L([], "s1");
  assert.deepEqual(await L([], "s1"), { added: 0, removed: 0 }, "8 off two lists: held");
  assert.equal(H.status().held, 8);
  assert.ok(ps.every(H.isHiddenHash) && QH("p0"));
  assert.deepEqual(await L([], "s1"), { added: 0, removed: 0 }, "...and never later (no longer on his lists)");
  assert.deepEqual(await hhRows(), [], "the hub heard nothing");
  await L(ps.slice(0, 3), "s1");
  assert.equal(H.status().held, 5, "p0-p2 listed again: they leave the batch (nothing to decide)");
  await L(ps.slice(0, 1), "s1");
  assert.deepEqual(await L(ps.slice(0, 1), "s1"), { added: 0, removed: 0 }, "2 of 8 at once (25 %): held too");
  assert.deepEqual([H.status().held, H.status().held_batches.length], [7, 2]);
  await L(ps.slice(0, 2), "s1");
  await L(ps.slice(0, 1), "s1");
  assert.deepEqual(await L(ps.slice(0, 1), "s1"), { added: 0, removed: 1 }, "one at a time: un-hidden");
  assert.equal(H.isHiddenHash(ps[1]), false);
});

test("refix 4: a failed start-up read never names anyone - until it has worked every reader hides everyone (quotes, tips, mentions, boost, go-live); once it works the stored set is back (review P3)", async () => {
  await fresh();
  await H.note([H.hash("shycf")]);
  H._reset();                                           // the process restarted: memory is empty, the table stays
  Q.setHidden([]);
  assert.equal(QH("shycf"), false, "(a process that never asked for the read - a test - is not held back)");
  const orig = D.getQuery;
  D.getQuery = async (sql, params) => { if (/FROM hub_hidden_set/.test(sql)) throw new Error("SQLITE_BUSY"); return orig(sql, params); };
  try {
    assert.equal(await H.boot(), null, "a failed read: nothing breaks");
    assert.deepEqual([H.loading(), H.status().booted], [true, false]);
    for (const l of ["shycf", "anyonecf", "bobcf"]) assert.deepEqual([QH(l), Q.isLeftOut(l)], [true, true], l + ": hidden while the set can't be read");
  } finally { D.getQuery = orig; }
  assert.equal(await H.boot(), 1, "the next call (or the retry timer) reads it");
  assert.deepEqual([H.loading(), QH("ShyCF"), QH("anyonecf")], [false, true, false], "back: only the stored ones");
  assert.equal(await H.boot(), 1, "once per process");
});

test("an owner's un-hide: one kind or all - at once (the hub hears it), audited with the hash and kinds only; Pepe's next list brings a still-hidden login back", async () => {
  await fresh();
  const sh = H.hash("shycf");
  await H.note([sh, h(9)]);
  await assert.rejects(H.unhideByOwner({ login: "shycf" }, OWNER, " "), (e) => e.refuse && e.code === "reason");
  await assert.rejects(H.unhideByOwner({ h: "not-a-hash" }, OWNER, "testing"), (e) => e.refuse && e.code === "bad_key");
  await assert.rejects(H.unhideByOwner({ login: "shycf", kind: "everything" }, OWNER, "testing"), (e) => e.refuse && e.code === "bad_kind");
  await assert.rejects(H.unhideByOwner({ login: "shycf" }, null, "testing"), (e) => e.refuse && e.code === "owner_only");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'hubseam.unhide'"))[0].n, 0, "a refusal changes and audits nothing");
  await runQuery("DELETE FROM hub_outbox");
  const r = await H.unhideByOwner({ login: " @ShyCF " }, OWNER, "used !bridge show on an older Pepe");
  assert.deepEqual(r, { h: sh, kind: "all", was_hidden: true, kinds: ["unknown"], still: [], held: null });
  assert.deepEqual(await set(), [h(9)]);
  assert.equal(QH("shycf"), false);
  assert.deepEqual(await hhRows(), ["hh:" + sh]);
  const a = (await getQuery("SELECT * FROM admin_audit WHERE action = 'hubseam.unhide'"))[0];
  assert.equal(a.admin_name, "boss");
  assert.deepEqual(JSON.parse(a.detail), { h: sh, kind: "all", was_hidden: true, kinds: ["unknown"] });
  assert.doesNotMatch(a.detail, /shy/i, "the hash only - never the login");
  assert.deepEqual((await H.unhideByOwner({ h: h(9).toUpperCase() }, OWNER, "by hash")).was_hidden, true, "by hash");
  assert.equal((await H.unhideByOwner({ login: "nobody" }, OWNER, "testing")).was_hidden, false);
  await H.note([sh]);
  assert.equal(H.isHiddenHash(sh), true, "Pepe still lists them: hidden again");
  // one kind: incognito only leaves the unknown row (left out)
  await H.hiddenReported("shycf", Date.now());
  const k = await H.unhideByOwner({ login: "shycf", kind: "incognito" }, OWNER, "she asked by email");
  assert.deepEqual([k.was_hidden, k.kinds, k.still], [true, ["incognito", "unknown"], ["unknown"]]);
  assert.deepEqual([await kindsDb(sh), H.isLeftOutHash(sh)], [["unknown"], true]);
  assert.equal((await H.unhideByOwner({ login: "shycf", kind: "bridge" }, OWNER, "testing")).was_hidden, false, "a kind she doesn't have");
});

test("serialised: syncs arriving before a write starts share it, one arriving during it gets the next, and every list's additions are kept", async () => {
  await fresh();
  await H.note([]);
  const a = H.note([h(4)]);
  const b = H.note([h(5)]);
  const c = H.note([h(6)]);
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.deepEqual([ra, rb], [rc, rc], "one write for all three");
  assert.equal(ra.added, 3);
  const d = H.note([h(7)]);
  await new Promise((r) => setImmediate(r));
  const e = H.note([h(8)]);
  assert.equal((await d).added + (await e).added, 2);
  assert.deepEqual(await set(), [h(4), h(5), h(6), h(7), h(8)], "nothing superseded or lost");
  assert.deepEqual(await kept(), [h(4), h(5), h(6), h(7), h(8)]);
});

test("1.99acm: nothing is stored while hubseam.privacy is off; switching it off empties the table (no rows); on again: the whole sticky set", async () => {
  await fresh();
  await H.note([h(1), h(2)]);
  await runQuery("DELETE FROM hub_outbox");
  await HO.setSettings({ privacy: false });
  assert.deepEqual(await set(), [], "switching the feed off drops the set from the database");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox"))[0].n, 0, "...without telling the hub (the switch is off)");
  assert.deepEqual(await H.note([h(7)]), { ignored: true }, "off: ignored");
  assert.deepEqual(await set(), [], "off: not stored (the bridge sync calls note() whatever the switches say)");
  assert.equal(H.isHiddenHash(h(1)) && H.isHiddenHash(h(7)), true, "the set in memory keeps everyone (quotes use it)");
  assert.deepEqual(await kept(), [h(1), h(2), h(7)], "1.99add refix: and hub_hidden_set keeps it on disk whatever the switch says");
  assert.deepEqual(await H.noteSync({ list: [h(7)], events: [shown(h(2))] }), { ignored: true }, "an explicit un-hide while off still counts");
  await HO.setSettings({ privacy: true });
  assert.deepEqual(await H.note([h(7)]), { added: 2, removed: 0 }, "the first sync after the switch turns on writes the whole sticky set");
  assert.deepEqual(await set(), [h(1), h(7)]);
  assert.deepEqual(await kept(), [h(1), h(7)], "the explicit un-hide while off left the disk too");
});

test("the trigger: privacy/changed hh: rows for each added / explicitly removed hash - and each scope change - while hubseam.privacy is on", async () => {
  await HO.setSettings({ privacy: false });
  await fresh();
  await HO.setSettings({ privacy: true });
  await H.note([h(7), h(8)]);
  await H.note([h(8)]);
  await H.noteSync({ list: [h(8)], events: [shown(h(7))] });
  const r = await getQuery("SELECT topic, entity, payload FROM hub_outbox ORDER BY id");
  assert.deepEqual(r, [{ topic: "privacy/changed", entity: "hh:" + h(7), payload: null }, { topic: "privacy/changed", entity: "hh:" + h(8), payload: null },
                       { topic: "privacy/changed", entity: "hh:" + h(7), payload: null }]);
  // refix 4: a scope change is a row too (unchanged scope writes none)
  await runQuery("DELETE FROM hub_outbox");
  await H.noteSync({ list: [h(8), h(6)], incog: [h(6)], explicit: true });   // h(6): incognito only
  await H.noteSync({ list: [h(8), h(6)], incog: [h(6)], explicit: true });
  assert.deepEqual(await hhRows(), ["hh:" + h(6)]);
  await H.noteSync({ list: [h(8), h(6)], bridge: [h(6)], incog: [h(6)], explicit: true });   // ...and !bridge hide: left out
  assert.deepEqual([await hhRows(), await scopeOf(h(6))], [["hh:" + h(6), "hh:" + h(6)], null]);
});

test("1.99add refix: the set is kept on disk whatever the switches say - with hubseam.privacy off, a site restart (any deploy) after Pepe lost his state still hides them (review A)", async () => {
  await fresh();
  await HO.setSettings({ privacy: false });
  const L = pepe();
  const x = H.hash("xcf");
  await L([x], "a1");
  await L([], "a2");                                    // Pepe restarted and his bridge file failed to load
  assert.equal(QH("xcf"), true, "before the site restart");
  await restart();
  assert.equal(QH("xcf"), true, "after it: hub_hidden_set brought them back (the hub's table is empty while the switch is off)");
  assert.deepEqual(await set(), [], "the hub's copy stays empty while the switch is off");
  assert.deepEqual([H.status().held, H.status().held_batches[0].kind], [1, "restart"], "the held batch came back too");
  await L([], "a2");
  assert.equal(QH("xcf"), true);
  await HO.setSettings({ privacy: true });
  await L([], "a2");
  assert.deepEqual(await set(), [x], "switched on: the hub gets the whole sticky set");
});

test("1.99add refix: a site restart between an older Pepe's lists changes nothing - the list compared with and what it lacked once come back, so his !bridge show still un-hides (switch on and off; review B)", async () => {
  for (const on of [true, false]) {
    await fresh();
    await HO.setSettings({ privacy: on });
    const L = pepe();
    const [x, y, z] = ["xcf", "ycf", "zcf"].map(H.hash);
    const fill = fillOf("rb" + on, 20);
    await L([x, y, z, ...fill], "b1");
    await L([x, y, ...fill], "b1");                     // z: absent once
    await restart();
    assert.equal(QH("xcf") && QH("ycf") && QH("zcf"), true, "hidden again before Pepe's first sync");
    assert.equal(H.status().absent_once, 1, "what his last list lacked came back");
    await L([y, ...fill], "b1");                        // x typed !bridge show while the site was down; z is absent a second time
    assert.equal(H.isHiddenHash(z) || QH("zcf"), false, `z: un-hidden by the first list after the restart (switch ${on ? "on" : "off"})`);
    assert.equal(QH("xcf"), true, "x: absent once");
    await L([y, ...fill], "b1");
    assert.equal(H.isHiddenHash(x) || QH("xcf"), false, "x: un-hidden");
    assert.equal(QH("ycf"), true);
    assert.deepEqual(sorted(await kept()), sorted([y, ...fill]));
    if (on) {
      assert.deepEqual(sorted(await set()), sorted([y, ...fill]));
      assert.equal((await reader(x)).value, false, "the hub hears it");
    }
  }
  await HO.setSettings({ privacy: true });
});

test("1.99add refix: held batches wait for an owner - approve takes their unknown rows away (audited without a hash, one transaction), dismiss keeps them; decided once; open ones survive a restart (review C)", async () => {
  await fresh();
  const L = pepe();
  const [x, y, z] = ["xcf", "ycf", "zcf"].map(H.hash);
  await L([x, y, z], "c1");
  await L([z], "c2");                                   // his restart: x typed !bridge show just before it, y's state was lost
  assert.equal(H.status().held, 2);
  assert.equal(QH("xcf") && QH("ycf"), true, "held = still hidden");
  await L([z, y], "c2");                                // y is hidden again: she leaves the batch (nothing to decide)
  const [b1] = H.status().held_batches;
  assert.deepEqual([b1.kind, b1.n, b1.other, H.status().held], ["restart", 1, 0, 1]);
  assert.ok(!JSON.stringify(H.status()).includes(x) && !JSON.stringify(H.status()).includes(y), "the status never carries a hash");
  await assert.rejects(H.decideHeld(b1.id, true, OWNER, " "), (e) => e.refuse && e.code === "reason");
  await assert.rejects(H.decideHeld("nope", true, OWNER, "testing"), (e) => e.refuse && e.code === "not_found");
  await assert.rejects(H.decideHeld("0123456789ab", true, OWNER, "testing"), (e) => e.refuse && e.status === 404);
  await assert.rejects(H.decideHeld(b1.id, "yes", OWNER, "testing"), (e) => e.refuse && e.code === "bad");
  await assert.rejects(H.decideHeld(b1.id, true, null, "testing"), (e) => e.refuse && e.code === "owner_only");
  const audits = () => getQuery("SELECT * FROM admin_audit WHERE action = 'hubseam.held' ORDER BY id");
  assert.equal((await audits()).length, 0, "a refusal audits nothing");
  await runQuery("DELETE FROM hub_outbox");
  assert.deepEqual(await H.decideHeld(b1.id, true, OWNER, "x asked with !bridge show before the restart"), { id: b1.id, approved: true, removed: 1, still_hidden: 0 });
  assert.equal(H.isHiddenHash(x) || QH("xcf"), false);
  assert.deepEqual(await kept(), sorted([y, z]));
  assert.deepEqual(await hhRows(), ["hh:" + x], "the hub hears it");
  const a = await audits();
  assert.equal(a.length, 1);
  assert.equal(a[0].admin_name, "boss");
  assert.deepEqual(JSON.parse(a[0].detail), { id: b1.id, kind: "restart", n: 1, approve: true });
  assert.ok(!a[0].detail.includes(x), "never a hash");
  await assert.rejects(H.decideHeld(b1.id, true, OWNER, "again"), (e) => e.refuse && e.code === "decided");
  // another of his restarts loses y again (and y is incognito too): approving takes only the unknown row - she stays "someone"
  await H.hiddenReported("ycf", L.now());
  await L([z], "c3");
  await restart();
  const open = H.status().held_batches;
  assert.deepEqual([open.length, open[0].kind, open[0].n, open[0].other], [1, "restart", 1, 1], "open batches come back, decided ones don't; one of it stays hidden another way");
  await assert.rejects(H.decideHeld(b1.id, false, OWNER, "testing"), (e) => e.refuse && e.code === "decided", "decided before the restart: still decided");
  assert.deepEqual(await H.decideHeld(open[0].id, true, OWNER, "she asked"), { id: open[0].id, approved: true, removed: 1, still_hidden: 1 });
  assert.deepEqual([QH("ycf"), Q.isLeftOut("ycf")], [true, false], "y: incognito - shown as someone");
  // dismissed: they stay
  await L([y, z], "c4");
  await L([z], "c5");
  const [b3] = H.status().held_batches;
  assert.deepEqual(await H.decideHeld(b3.id, false, OWNER, "her state was lost - keep her hidden"), { id: b3.id, approved: false, removed: 0, still_hidden: 0 });
  assert.equal(Q.isLeftOut("ycf"), true);
  assert.equal((await getQuery("SELECT state FROM hub_hidden_held WHERE id = ?", [b3.id]))[0].state, "dismissed");
  // an upgrade: the run before was an older Pepe and the new one sends privacy.shown (no kinds yet) - what the old run's last list had is held too
  await L([y, z], "c6");
  await L([z], "c7", { explicit: true });
  assert.deepEqual([H.status().held, H.status().held_batches[0].kind], [1, "restart"]);
  // a CL1 run restarting into a CL1 run: he sends privacy.shown for a real un-hide - nothing more is held
  await L([z], "c8", { explicit: true });
  await L([], "c9", { explicit: true });
  assert.equal(H.status().held, 1);
  assert.equal(QH("zcf"), true);
});

test("1.99add refix: a mass drop explained by Pepe's word releases its last hash (two people un-hiding in one tick); one listed again keeps the rest held (review D / D2)", async () => {
  await freshAll();
  const L = pepe();
  const hs = ["alicecf", ...Array.from({ length: 11 }, (_, i) => "p" + i + "cf")].map(H.hash);
  const [al, p0, p1, p2] = hs;
  await L(hs, "d1");
  const at = L.now() + 200;                             // in one tick p0 types !bridge show and alice turns incognito off
  await L(hs.slice(2), "d1");
  assert.deepEqual(await L(hs.slice(2), "d1"), { added: 0, removed: 0 }, "2 of 12 off two lists: held");
  assert.equal(H.status().held, 2);
  await I.sync({ items: [{ login: "AliceCF", on: false, ts: at, via: "chat" }] });   // her report comes late
  assert.equal(H.isHiddenHash(al) || QH("alicecf"), false, "alice: her OFF report (between the list that had her and the first without) explains her");
  assert.equal(H.isHiddenHash(p0) || QH("p0cf"), false, "p0: the batch's only unexplained drop - a lone !bridge show");
  assert.deepEqual([H.status().held, H.status().released], [0, 1]);
  // two more vanish at once and one of them is back on a later list: a glitch, not two people - the other stays held
  await L(hs.slice(4), "d1");
  await L(hs.slice(4), "d1");
  assert.equal(H.status().held, 2);
  await L([p1, ...hs.slice(4)], "d1");
  assert.deepEqual([H.status().held, H.isHiddenHash(p2), H.isHiddenHash(p1)], [1, true, true]);
  // three vanish; then one is shown explicitly (privacy.shown, between the lists) and another is listed again: the third stays held
  const [p4, p5, p6] = hs.slice(6, 9);
  const rest = hs.slice(9);
  const t6 = L.now() + 100;
  await L([p1, ...hs.slice(4, 6), ...rest], "d1");
  await L([p1, ...hs.slice(4, 6), ...rest], "d1");
  assert.equal(H.status().held, 4, "p2 + p4, p5, p6");
  await L([p1, p4, ...hs.slice(4, 6), ...rest], "d1", { events: [shown(p6, "bridge", t6)] });
  assert.deepEqual([H.isHiddenHash(p6), H.isHiddenHash(p5), H.status().held], [false, true, 2], "a glitch was in that batch: p5 is not released");
});

test("1.99add refix: a lost bridge state is never undone by a no-op incognito OFF, nor by a real OFF from before Pepe's last list before his restart (review E)", async () => {
  await fresh();
  const L = pepe();
  const [bo, st, du] = ["bobcf", "strangercf", "dualcf"].map(H.hash);
  const dualOff = L.now() + 1;                          // dual (on incognito AND !bridge hide) turns incognito off; his report is slow
  await L([bo, st, du], "e1");                          // Pepe's last list before his restart - built after dual's OFF: still has him
  await L([], "e2");                                    // Pepe restarted, his bridge file failed to load: all three were on !bridge hide
  assert.equal(H.status().held, 3, "held for an owner (across a restart)");
  await I.sync({ items: [{ login: "bobcf", on: false, ts: L.now() + 1, via: "web", changed: false },
                         { login: "strangercf", on: false, ts: L.now() + 1, via: "chat", changed: false },
                         { login: "dualcf", on: false, ts: dualOff, via: "chat" }] });
  await L([], "e2");
  assert.equal(QH("bobcf") && QH("strangercf"), true, "a no-op OFF (linked or not) says nothing about !bridge hide: still hidden");
  assert.equal(QH("dualcf"), true, "dual's real OFF came before a list that still had him: it can't explain the restart's drop");
  assert.equal(H.status().held, 3, "all three still held");
});

test("1.99add refix: a website Incognito ON hides at once (incognito, src web, before Pepe confirms), and so does Pepe's ON report with no bridge sync at all (review F)", async () => {
  await fresh();
  const al = H.hash("alicecf");
  await I.request("u-alice", true);
  assert.equal(QH("alicecf") && H.isHiddenHash(al), true, "before Pepe answers");
  assert.deepEqual([await kindsDb(al), await srcOf(al), Q.isLeftOut("alicecf")], [["incognito"], "web", false]);
  assert.deepEqual([await set(), await scopeOf(al)], [[al], "incognito"], "the hub's copy too (switch on): shown as someone");
  await I.sync({ items: [{ login: "newcf", on: true, ts: Date.now(), via: "chat" }] });
  assert.equal(QH("newcf"), true, "Pepe's ON report for an unlinked login: hidden with no room bridged");
  assert.equal(await srcOf(H.hash("newcf")), "report");
  await I.request("u-alice", false);
  assert.equal(QH("alicecf"), true, "a website OFF waits for Pepe's report");
});

test("refix 4: Pepe's clock is never compared with the site's - steadily minutes ahead it changes nothing; after a step back an ON still hides (P6), an OFF after it counts, and a list after it is compared with what came before (clock probes S1 / S2)", async () => {
  await freshAll();
  // his clock 5 minutes ahead of the site's, steadily (a Windows VM that drifted): his lists are in order by his own times
  const L = pepe(Date.now() + 5 * 60 * 1000);
  const [ca, dn] = ["carolcf", "dancf"].map(H.hash);
  const fill = fillOf("g", 20);
  await L([ca, dn, ...fill], "g1");
  await L([dn, ...fill], "g1");
  assert.deepEqual(await L([dn, ...fill], "g1"), { added: 0, removed: 1 }, "carol's !bridge show un-hides");
  await I.sync({ items: [{ login: "dancf", on: false, ts: L.now() + 10, via: "chat" }] });
  assert.deepEqual(await L(fill, "g1"), { added: 0, removed: 1 }, "dan's OFF explains his drop");
  assert.ok(H.status().clock_s >= 290 && H.status().untimed === 0, "his clock is shown on the card - and used for nothing");
  // P6: his clock jumps an hour ahead, an unlinked member turns incognito on and off, NTP corrects it, she turns it on again
  await freshAll();
  const fut = Date.now() + 3600 * 1000;
  await I.sync({ items: [{ login: "strangercf", on: true, ts: fut - 10, changed: true }] });
  await I.sync({ items: [{ login: "strangercf", on: false, ts: fut, changed: true }] });
  assert.equal(QH("strangercf"), false);
  await I.sync({ items: [{ login: "strangercf", on: true, ts: Date.now(), changed: true }] });
  assert.equal(QH("strangercf"), true, "an ON that looks older than his last OFF still hides (fail closed)");
  // ...and her OFF a few minutes later (still 'older' than the ON dated ahead, but that ON arrived long ago): it counts
  let now = Date.now();
  H._setClock(() => now);
  await I.sync({ items: [{ login: "strangercf", on: true, ts: fut + 5, changed: true }] });
  now += H.STALE_MS + 1000;
  await I.sync({ items: [{ login: "strangercf", on: false, ts: Date.now() + 1000, changed: true }] });
  assert.equal(QH("strangercf"), false, "not stuck hidden until his clock catches up");
  H._setClock(null);
  // S1: his clock 10 min ahead; an unlinked member turns incognito OFF; his clock steps back; every list lacks her
  await freshAll();
  const others = fillOf("o", 30);
  const z = H.hash("zedcf");
  let t = Date.now() + 600000;
  const L1 = (list) => { t += 1500; return H.noteSync({ list, session: "s1", sent: new Date(t).toISOString() }); };
  await L1([...others, z]);
  await L1([...others, z]);
  t += 200;
  await I.sync({ items: [{ login: "zedcf", on: false, ts: t, changed: true }] });
  t -= 600000;                                          // NTP steps his clock back
  for (let i = 0; i < 3; i++) await L1(others);
  assert.equal(QH("zedcf"), false, "S1: un-hidden by two in-order lists after the step (no OFF waits, nothing held)");
  assert.deepEqual([H.status().held, H.status().back], [0, 1]);
  // S2: a !bridge show right as his clock steps back, another one a moment later
  await freshAll();
  const ps = fillOf("p", 30);
  t = Date.now() + 600000;
  const L2 = (list) => { t += 1500; return H.noteSync({ list, session: "s2", sent: new Date(t).toISOString() }); };
  await L2(ps);
  await L2(ps);
  t -= 600000;
  await L2(ps.slice(1));                                // p0 did !bridge show right as the clock stepped back (out of order)
  await L2(ps.slice(2));                                // p1 a moment later
  await L2(ps.slice(2));
  assert.deepEqual([H.isHiddenHash(ps[0]), H.isHiddenHash(ps[1]), H.status().held], [false, false, 0], "both un-hidden, nothing held");
  // S3: a list that came out of order explains nothing - an OFF dated after it but before the list that still had her (she is on
  // !bridge hide too) can't make one short list after it an un-hide: absent once, and back on the next
  await freshAll();
  const qs = fillOf("q", 30);
  const v = H.hash("vcf");
  t = Date.now() - 600000;
  const L3 = (list, at) => H.noteSync({ list, session: "s3", sent: new Date(at).toISOString() });
  await L3([v, ...qs], t);
  await L3([v, ...qs], t + 10000);
  await L3([v, ...qs], t + 2000);                       // out of order (a late post)
  await I.sync({ items: [{ login: "vcf", on: false, ts: t + 5000, changed: true }] });   // before the list at t + 10000, which still had her
  await L3(qs, t + 11000);                              // a read that failed once
  assert.deepEqual([H.isHiddenHash(v), H.status().absent_once], [true, 1], "not explained by that OFF: absent once");
  await L3([v, ...qs], t + 12000);
  assert.deepEqual([H.isHiddenHash(v), H.status().absent_once], [true, 0], "back on the next list: she stays hidden");
});

test("refix 4: privacy.shown is taken once - a resend (the same event id), one in a late post of an older run, and one older (his clock) than a hide of that kind that just arrived are ignored; past STALE_MS a clock that went back counts (review P8)", async () => {
  await fresh();
  const x = H.hash("redcf");
  const t0 = Date.now() - 600000;
  const s = (events, list, sent, session = "cl1") => H.noteSync({ list, events, session, sent: new Date(sent).toISOString(), explicit: true });
  await s([hidden(x, "bridge", t0)], [x], t0);
  const sh = shown(x, "bridge", t0 + 1000);
  await s([sh], [], t0 + 1000);
  assert.equal(H.isHiddenHash(x), false);
  await s([hidden(x, "bridge", t0 + 2000)], [x], t0 + 2000);
  // a late post of the earlier payload (the same shown, an older `sent`, an empty list): the id was taken - re-hidden stays
  assert.deepEqual(await s([sh], [], t0 + 1000), { added: 0, removed: 0 });
  assert.deepEqual([H.isHiddenHash(x), H.status().dup], [true, 1]);
  // a shown dated before the hide that just arrived (a late post with its own id): ignored
  await s([shown(x, "bridge", t0 + 1500)], [], t0 + 1500);
  assert.deepEqual([H.isHiddenHash(x), H.status().late], [true, 1]);
  // a late post of an OLDER run (a session seen before): its shown counts for nothing
  await s([hidden(x, "bridge", t0 + 3000)], [x], t0 + 3000, "cl2");
  await s([shown(x, "bridge", t0 + 4000)], [], t0 + 4000, "cl1");
  assert.equal(H.isHiddenHash(x), true);
  // his clock stepped back since the hide: once that hide is older than STALE_MS (our clock), his show counts
  let now = Date.now();
  H._setClock(() => now);
  await s([hidden(x, "bridge", t0 + 900000)], [x], t0 + 900000, "cl2");   // dated 15 min ahead
  now += H.STALE_MS + 1000;
  assert.deepEqual(await s([shown(x, "bridge", t0 + 5000)], [], t0 + 5000, "cl2"), { added: 0, removed: 1 }, "counted - not stuck hidden");
  H._setClock(null);
});

test("refix 4: Pepe's OFF reports that explain drops survive a site restart (and his own)", async () => {
  await freshAll();
  const L = pepe();
  const al = H.hash("alicecf");
  const fill = fillOf("pr", 10);
  await L([al, ...fill], "p1");
  await H.offReported("alicecf", L.now() + 1);
  await restart();
  assert.deepEqual(await L(fill, "p2"), { added: 0, removed: 0 }, "his first list after both restarts: the stored list's time isn't known - held");
  assert.deepEqual(H.status().held_batches.map((b) => b.kind), ["restart"]);
  // ...but a restart batch formed while the site knew the list's time is explained by the stored report
  await freshAll();
  const L2 = pepe();
  await L2([al, ...fill], "p3");
  await H.offReported("alicecf", L2.now() + 1);
  const offs = JSON.parse((await getQuery("SELECT value FROM hub_hidden_meta WHERE key = 'offs'"))[0].value);
  assert.deepEqual(offs, [[al, L2.now() + 1]], "stored: hash and his time only");
  assert.deepEqual(await L2(fill, "p4"), { added: 0, removed: 1 }, "his restart: her OFF (after his last list) explains it");
  assert.equal(H.status().held, 0);
});

test("1.99add refix: an owner's un-hide is one transaction with its audit row - a failed write changes nothing and audits nothing", async () => {
  await fresh();
  const sh = H.hash("shycf");
  await H.note([sh]);
  const count = async () => (await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'hubseam.unhide'"))[0].n;
  const n0 = await count();
  const orig = D.runQuery;
  D.runQuery = async (sql, params) => { if (/DELETE FROM hub_hidden_set/.test(sql)) throw new Error("disk full"); return orig(sql, params); };
  try { await assert.rejects(H.unhideByOwner({ login: "shycf" }, OWNER, "testing"), /disk full/); } finally { D.runQuery = orig; }
  assert.equal(H.isHiddenHash(sh) && QH("shycf"), true, "still hidden");
  assert.deepEqual([await set(), await kept()], [[sh], [sh]]);
  assert.equal(await count(), n0, "the audit row rolled back with it");
  assert.equal((await H.unhideByOwner({ login: "shycf" }, OWNER, "testing")).was_hidden, true, "and it works once the database does");
  assert.deepEqual([await set(), await kept()], [[], []]);
});

test("bridge.js boots the set first and hands Pepe's lists (mixed and kinded), events, session, sent time and CL1 marker over without waiting; quotes never get the raw list; every incognito report and his full list reach it", () => {
  const src = fs.readFileSync(path.join(repo, "bridge.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /require\("\.\/hubhidden"\)\.noteSync\(\{ list: body\.hidden_h, bridge: body\.bridge_hidden_h, incog: body\.incog_hidden_h, events: body\.events,\s+session: body\.session, sent: body\.sent, explicit: Array\.isArray\(body\.tx_hidden_h\) \}\)\s+\.catch\(/);
  assert.match(src, /load\(\);\s*(?:\/\/[^\n]*\s*)*require\("\.\/hubhidden"\)\.boot\(\);/, "register() reads the stored set back at start-up, first");
  assert.ok(!/await require\("\.\/hubhidden"\)/.test(src), "the sync answer never waits for it");
  assert.ok(!/setHidden\(body\.hidden_h\)/.test(src), "quotes never take a raw list (it would fail open)");
  const inc = fs.readFileSync(path.join(repo, "incognito.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(inc, /\n\s+if \(on\) await require\("\.\/hubhidden"\)\.hiddenReported\(login, ts\);\n\s+else await require\("\.\/hubhidden"\)\.offReported\(login, ts, \{ changed: it\.changed !== false \}\);\n/,
               "every report (stale or not): an ON hides, an OFF goes to offReported");
  assert.match(inc, /await require\("\.\/hubhidden"\)\.fullReported\(\[\.\.\.set\]\);/, "his full list adds the incognito kind");
  // (cl-site's merge: the pad chat archive's own hide - chatlog.hideNow, in its try - comes first in the same block)
  assert.match(inc, /if \(on\) \{\s+(?:try \{[\s\S]*?require\("\.\/chatlog"\)[\s\S]*?\} catch \(e\) \{[^\n]*\}\s+)?await require\("\.\/hubhidden"\)\.hideNow\(login, "web"\);\s+await actionsSettled\(\[id\]\);\s+\}\s+return \{ id \};/,
               "a website ON hides at once (after its transaction) - and settles at once if Pepe already answered it");
  assert.match(inc, /init\(\)\.catch\([^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*require\("\.\/hubhidden"\)\.whenBooted\(reconcileWeb\);/, "register() settles website ONs answered while the site was down");
  const act = fs.readFileSync(path.join(repo, "actions.js"), "utf8");
  assert.match(act, /UPDATE pepe_actions SET status = \?, message = \?[\s\S]*?await require\("\.\/incognito"\)\.actionsSettled\(acked\);\s+res\.json\(\{ ok: true \}\);/,
               "the ack settles them after the statuses are written, before it answers");
  const ttl = fs.readFileSync(path.join(repo, "actionttl.js"), "utf8");
  assert.match(ttl, /if \(table === "pepe_actions" && row\.kind === "privacy\.incognito"\) await require\("\.\/incognito"\)\.actionsSettled\(\[row\.id\]\);/,
               "an expired ON settles them");
  const mc = fs.readFileSync(path.join(repo, "micclip.js"), "utf8");
  // (cl-site's merge: the archive's set is asked too - chatlogview.isHiddenLogin(login) || quotes.isHidden(login))
  assert.match(mc, /if \((?:require\("\.\/chatlogview"\)\.isHiddenLogin\(login\) \|\| )?require\("\.\/quotes"\)\.isHidden\(login\)\) return res\.status\(403\)/, "a private speaker's voice can't be clipped");
});

// ── the website side of incognito (actions, the request) ──

/** a clean slate that also forgets the website side (actions, incognito state, the request rate) */
async function freshAll() {
  await fresh();
  for (const t of ["pepe_actions", "incognito_log", "incognito_state"]) await runQuery(`DELETE FROM ${t}`);
}
let actBase = null, actServer = null;
/** actions.js's routes on a local port (Pepe's claim / ack) */
async function actionsApp() {
  if (actBase) return actBase;
  const express = require("express");
  const app = express();
  app.use(express.json());
  require(path.join(repo, "actions")).register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  actServer = app.listen(0);
  actBase = "http://127.0.0.1:" + actServer.address().port;
  return actBase;
}
test.after(() => { if (actServer) actServer.close(); });
const botPost = async (p, body) => {
  const r = await fetch((await actionsApp()) + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot", ...body }) });
  return r.json();
};
const lastAction = async (userId) => (await getQuery("SELECT * FROM pepe_actions WHERE user_id = ? ORDER BY id DESC LIMIT 1", [userId]))[0];

test("1.99add refix 2: a website Incognito ON that Pepe never applies is undone - it expired unclaimed, he refused it, or he answered a later web OFF as a no-op; one he applied stays, as sure as his own report (review P1)", async () => {
  await freshAll();
  const L = pepe();
  const [al, bo, ca, da, ev2] = ["alicecf", "bobcf", "carolcf", "dancf", "evecf"].map(H.hash);
  await L([ev2], "w1");                                 // eve is on !bridge hide (a list carried her)
  for (const u of ["u-alice", "u-bob", "u-carol", "u-dan", "u-eve"]) await I.request(u, true);
  assert.ok([al, bo, ca, da, ev2].every(H.isHiddenHash), "all hidden at once");
  assert.deepEqual([await srcOf(al), await kindsDb(ev2)], ["web", ["incognito", "unknown"]], "eve: her list's row stays, the website ON is its own kind");
  assert.equal(H.status().web, 5);
  await runQuery("DELETE FROM hub_outbox");
  // alice and eve: their ONs wait past the TTL (Pepe's VM down) - the sweep before his next claim expires them
  const old = Date.now() - 16 * 60000;
  for (const u of ["u-alice", "u-eve"]) await runQuery("UPDATE pepe_actions SET created = ? WHERE user_id = ?", [old, u]);
  const claim = await botPost("/api/actions/claim", {});
  assert.deepEqual(claim.actions.map((a) => a.user_id).sort(), ["u-bob", "u-carol", "u-dan"], "the expired ones are never handed out");
  assert.equal((await lastAction("u-alice")).status, "failed");
  assert.equal(H.isHiddenHash(al) || QH("alicecf"), false, "alice: Pepe never applied it - un-hidden");
  assert.equal((await reader(al)).value, false, "the hub hears it");
  assert.deepEqual([H.isHiddenHash(ev2), await kindsDb(ev2)], [true, ["unknown"]], "eve: her list still hides her");
  // bob: Pepe refuses his (ack failed); carol: done (and then Pepe's report of it); dan: left claimed
  const id = async (u) => (await lastAction(u)).id;
  await botPost("/api/actions/ack", { results: [{ id: await id("u-bob"), ok: false, message: "not now" }, { id: await id("u-carol"), ok: true, message: "on" }] });
  assert.equal(H.isHiddenHash(bo) || QH("bobcf"), false, "bob: refused - un-hidden");
  assert.equal(H.isHiddenHash(ca) && QH("carolcf"), true, "carol: applied - hidden");
  assert.equal(await srcOf(ca), "report", "as sure as Pepe's own report");
  await I.sync({ items: [{ login: "carolcf", on: true, ts: L.now() + 1, via: "web", changed: true }] });
  // dan: his ON is never answered; he turns it OFF on the website, Pepe answers that one as a no-op: un-hidden, also after a restart
  await I.request("u-dan", false);
  await I.sync({ items: [{ login: "dancf", on: false, ts: L.now() + 2, via: "web", changed: false }] });
  assert.equal(H.isHiddenHash(da) || QH("dancf"), false, "dan: un-hidden");
  await L([ev2], "w1");
  await restart();
  await L([ev2], "w1");
  assert.deepEqual([QH("alicecf"), QH("bobcf"), QH("carolcf"), QH("dancf"), QH("evecf")], [false, false, true, false, true]);
  assert.deepEqual(sorted(await kept()), sorted([ca, ev2]));
  // a late outcome of dan's ON changes nothing now; carol's done ON can't be undone by an outcome (only a "web" row)
  const danOn = (await getQuery(`SELECT id FROM pepe_actions WHERE user_id = 'u-dan' AND args = '["on"]'`))[0].id;
  await runQuery("UPDATE pepe_actions SET status = 'failed' WHERE id = ?", [danOn]);
  assert.equal(await I.actionsSettled([danOn, await id("u-dan")]), 1, "only an ON with an outcome settles");
  assert.equal(QH("dancf"), false);
  await H.webSettled("carolcf", false);
  assert.equal(QH("carolcf"), true);
  await I.sync({ items: [{ login: "carolcf", on: false, ts: L.now() + 3, via: "chat", changed: true }] });
  assert.equal(QH("carolcf"), false);
});

test("1.99add refix 2: no site-clock stamps - reports are ordered by Pepe's clock only: an OFF right after his report of a website ON counts even with his clock behind the site's; an OFF older than an ON that just arrived is a late post (ignored)", async () => {
  await freshAll();
  const L = pepe();
  const [al, bo, ca] = ["alicecf", "bobcf", "carolcf"].map(H.hash);
  await L([bo, ca], "k1");                              // bob and carol are hidden (his list carries them)
  await I.request("u-alice", true);
  const pt = Date.now() - 5000;
  await I.sync({ items: [{ login: "alicecf", on: true, ts: pt, via: "web", changed: true }] });
  await I.sync({ items: [{ login: "alicecf", on: false, ts: pt + 1000, via: "chat", changed: true }] });
  assert.equal(H.isHiddenHash(al) || QH("alicecf"), false, "her OFF counts (no list ever carried her: at once)");
  // bob: his chat OFF lands after he clicked ON on the website, before Pepe ran it: the website ON (provisional) goes; the next list
  // drops him and his OFF explains it; Pepe's report of the ON hides him again, and an OFF older than that ON is ignored
  const t0 = L.now() + 10;
  await I.request("u-bob", true);
  assert.equal(QH("bobcf"), true);
  await I.sync({ items: [{ login: "bobcf", on: false, ts: t0, via: "chat", changed: true }] });
  await L([ca], "k1");
  assert.equal(H.isHiddenHash(bo) || QH("bobcf"), false, "Pepe's state then: off");
  await I.sync({ items: [{ login: "bobcf", on: true, ts: t0 + 5000, via: "web", changed: true }] });
  assert.equal(H.isHiddenHash(bo) && QH("bobcf"), true, "his report of the website ON");
  assert.deepEqual(await H.offReported("bobcf", t0 + 1), { removed: 0, ignored: 1 }, "an OFF older than that ON (his clock), right after it: a late post - ignored");
  assert.equal(QH("bobcf"), true);
});

test("1.99add refix 2: a hash only Pepe's ON report put there goes on that login's real OFF, linked or not - also with no list at all in between and across a site restart; once a list carried them too, his list decides that part (review P4)", async () => {
  await freshAll();
  const L = pepe();
  await L([], "u1");
  const [st, al, x] = ["strangercf", "alicecf", "xcf"].map(H.hash);
  await I.sync({ items: [{ login: "strangercf", on: true, ts: L.now() + 10, via: "chat" }, { login: "AliceCF", on: true, ts: L.now() + 10, via: "chat" }] });
  assert.deepEqual([await srcOf(st), await srcOf(al)], ["report", "report"]);
  await restart();                                      // (the site restarts; no room is bridged: Pepe sends no list)
  await I.sync({ items: [{ login: "strangercf", on: false, ts: L.now() + 60000, via: "chat" }, { login: "AliceCF", on: false, ts: L.now() + 60000, via: "chat" }] });
  assert.equal(H.isHiddenHash(st) || QH("strangercf"), false, "unlinked: un-hidden");
  assert.equal(H.isHiddenHash(al) || QH("alicecf"), false, "linked: un-hidden");
  assert.deepEqual(await kept(), []);
  await I.sync({ items: [{ login: "xcf", on: true, ts: L.now() + 70000, via: "chat" }] });
  await H.noteSync({ list: [x], session: "u1", sent: new Date(L.now() + 75000).toISOString() });
  assert.deepEqual(await kindsDb(x), ["incognito", "unknown"]);
  await I.sync({ items: [{ login: "xcf", on: false, ts: L.now() + 80000, via: "chat", changed: true }] });
  assert.deepEqual([QH("xcf"), Q.isLeftOut("xcf")], [true, true], "his list's row: left out until his list drops him");
  await H.noteSync({ list: [], session: "u1", sent: new Date(L.now() + 90000).toISOString() });
  assert.equal(QH("xcf"), false, "...which his OFF explains: un-hidden");
});

test("1.99add refix 2: an owner's un-hide of one member of a held mass batch is no evidence about the others - they stay held (also across a restart, and after Pepe explains another) for the owner to decide (review P2)", async () => {
  await freshAll();
  const L = pepe();
  const hs = Array.from({ length: 12 }, (_, i) => H.hash("m" + i + "cf"));
  await L(hs, "m1");
  const between = L.now() + 100;
  await L(hs.slice(3), "m1");
  await L(hs.slice(3), "m1");                           // m0, m1 and m2 vanish: held
  assert.equal(H.status().held, 3);
  await H.unhideByOwner({ login: "m0cf" }, OWNER, "m0 asked to be shown by email");
  assert.equal(QH("m0cf"), false);
  assert.equal(QH("m1cf") && QH("m2cf"), true, "m1 and m2 stay hidden");
  assert.deepEqual([H.status().held, H.status().released], [2, 0], "...and held");
  await L(hs.slice(3), "m1");
  await restart();
  const [b] = H.status().held_batches;
  assert.deepEqual([b.kind, b.n], ["mass", 2], "still held after a restart");
  assert.equal((await getQuery("SELECT manual FROM hub_hidden_held WHERE id = ?", [b.id]))[0].manual, 1);
  // Pepe explains m1 (his privacy.shown): m2 is still not a lone !bridge show - m0 was never explained - so it stays held
  await L(hs.slice(3), "m1", { events: [shown(hs[1], "bridge", between)] });
  assert.equal(QH("m1cf"), false, "m1: explained by Pepe");
  assert.equal(QH("m2cf"), true, "m2: still held");
  assert.deepEqual([H.status().held, H.status().released], [1, 0]);
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM admin_audit"))[0].n;
  assert.deepEqual(await H.decideHeld(b.id, true, OWNER, "m2 used !bridge show too"), { id: b.id, approved: true, removed: 1, still_hidden: 0 });
  assert.equal(QH("m2cf"), false);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit"))[0].n, n0 + 1, "the owner's decision is audited");
});

test("1.99add refix 2: a failed start-up read - lists only add until it is back: nothing compared, the stored list and reports never overwritten, a list's word kept; once back, the !bridge show in the window un-hides (review P3)", async () => {
  await freshAll();
  const L = pepe();
  const [x, z, y, w] = ["xcf", "zcf", "ycf", "wcf"].map(H.hash);
  const fill = fillOf("p3", 20);
  await L([x, z, y, ...fill], "b1");
  await H.offReported("ycf", L.now() + 100);           // y's OFF (stored: it may explain a drop)
  await I.sync({ items: [{ login: "wcf", on: true, ts: L.now() + 200, via: "chat" }] });
  H._reset();
  Q.setHidden([]);
  const orig = D.getQuery;
  let fail = true;
  D.getQuery = async (sql, params) => { if (fail && /FROM hub_hidden_meta/.test(sql)) throw new Error("SQLITE_BUSY"); return orig(sql, params); };
  try {
    assert.equal(await H.boot(), null);
    await L([z, w, ...fill], "b1");                      // x typed !bridge show in the window; y's OFF; w's room is bridged now
    assert.equal(H.isHiddenHash(z) && H.isHiddenHash(x), true, "it still adds (and the stored set came back)");
    assert.equal(H.status().booted, false);
    await H.offReported("qcf", L.now() + 100000);
    const offs = JSON.parse((await orig("SELECT value FROM hub_hidden_meta WHERE key = 'offs'"))[0].value).map((p) => p[0]);
    assert.deepEqual(offs, [y], "the stored reports were not overwritten with memory's part");
  } finally { fail = false; D.getQuery = orig; }
  const meta = JSON.parse((await getQuery("SELECT value FROM hub_hidden_meta WHERE key = 'last'"))[0].value);
  assert.deepEqual(sorted(meta.set), sorted([x, z, y, ...fill]), "the stored list was not overwritten");
  assert.deepEqual(await kindsDb(w), ["incognito", "unknown"], "a list carried w: his row and the report's both kept");
  await L([z, w, ...fill], "b1");                        // the read works now: compared with the stored list
  assert.equal(H.status().booted, true);
  assert.equal(QH("ycf"), true, "the stored list's time isn't known: a report can't explain it - absent once");
  await L([z, w, ...fill], "b1");
  assert.equal(H.isHiddenHash(x) || QH("xcf") || QH("ycf"), false, "x's !bridge show and y: two lists - un-hidden");
  assert.equal(QH("zcf"), true);
  await new Promise((r) => setTimeout(r, 30));
  const offs = JSON.parse((await getQuery("SELECT value FROM hub_hidden_meta WHERE key = 'offs'"))[0].value).map((p) => p[0]);
  assert.deepEqual(sorted(offs), sorted([y, H.hash("qcf")]), "the report taken meanwhile was stored once the read was back");
});

test("1.99add refix 2: a website ON's outcome settles only once no other ON of theirs is open; one that came while the site was down (or just before a restart) settles at start-up (incognito.reconcileWeb)", async () => {
  await freshAll();
  const [al, bo, ca, da] = ["alicecf", "bobcf", "carolcf", "dancf"].map(H.hash);
  await I.request("u-dan", true);
  await I.request("u-dan", true);
  const [d1, d2] = (await getQuery("SELECT id FROM pepe_actions WHERE user_id = 'u-dan' ORDER BY id")).map((r) => r.id);
  await runQuery("UPDATE pepe_actions SET status = 'failed' WHERE id = ?", [d1]);
  assert.equal(await I.actionsSettled([d1]), 0, "another ON of his is still open");
  assert.equal(QH("dancf"), true);
  await runQuery("UPDATE pepe_actions SET status = 'failed' WHERE id = ?", [d2]);
  assert.equal(await I.actionsSettled([d2]), 1);
  assert.equal(H.isHiddenHash(da) || QH("dancf"), false);
  await I.request("u-alice", true);
  await I.request("u-bob", true);
  await I.request("u-carol", true);
  await runQuery("UPDATE pepe_actions SET status = 'failed' WHERE user_id = 'u-alice'");
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE user_id = 'u-bob'");
  await restart();
  assert.equal(QH("alicecf") && QH("bobcf") && QH("carolcf"), true, "back from hub_hidden_set (src web)");
  assert.equal(H.status().web, 3, "all provisional as far as the stored set knows");
  assert.equal(await I.reconcileWeb(), 3, "alice, bob - and dan's newest (failed: nothing left to undo)");
  assert.equal(H.isHiddenHash(al) || QH("alicecf"), false, "alice's failed ON: un-hidden");
  assert.equal(H.isHiddenHash(bo) && QH("bobcf"), true, "bob's done ON: hidden");
  assert.equal(await srcOf(bo), "report");
  assert.equal(await srcOf(ca), "web", "carol's still waits for Pepe: untouched");
  assert.equal(H.status().web, 1);
  let ran = 0;
  await restart();
  await H.whenBooted(() => { ran++; });
  assert.equal(ran, 1, "after the start-up read it runs at once");
});

test("1.99add refix 3: a held mass batch is released only on Pepe's word about a change BETWEEN the list that had them and the first without - a later OFF leaves the rest held for an owner; an OFF from before that list explains nothing (review H1)", async () => {
  await freshAll();
  let L = pepe();
  const fill = fillOf("h1f", 10);
  const [A, B, C, Dn] = ["alicecf", "bobcf", "carolcf", "dancf"].map(H.hash);
  await L([A, B, ...fill], "m1");
  await L(fill, "m1");
  await L(fill, "m1");                                  // A and B vanish together while still hidden in Pepe (his memory read failing): held
  assert.deepEqual(H.status().held_batches.map((b) => [b.kind, b.n]), [["mass", 2]]);
  // a minute later alice really turns incognito OFF: it says nothing about why they vanished - both stay held
  await I.sync({ items: [{ login: "alicecf", on: false, ts: L.now() + 60000, via: "chat" }] });
  await H.noteSync({ list: fill, session: "m1", sent: new Date(L.now() + 61500).toISOString() });
  assert.equal(H.isHiddenHash(B) && QH("bobcf") && QH("alicecf"), true, "nothing explains why they vanished");
  assert.deepEqual([H.status().held, H.status().released], [2, 0]);
  // carol and dan vanish together; carol's OFF from BEFORE the list that still had her arrives late - it explains nothing
  await freshAll();
  L = pepe();
  const early = L.now() + 1;
  await L([C, Dn, ...fill], "m2");
  const between = L.now() + 100;
  await L(fill, "m2");
  await L(fill, "m2");
  assert.deepEqual(await H.offReported("carolcf", early), { removed: 0, ignored: 0 });
  assert.deepEqual([QH("carolcf"), QH("dancf"), H.status().held], [true, true, 2]);
  // dan's OFF between the two lists (its report late) explains HIS drop: carol is then the batch's only unexplained one - released
  assert.deepEqual(await H.offReported("dancf", between), { removed: 2, ignored: 0 });
  assert.deepEqual([QH("carolcf"), QH("dancf"), H.status().held, H.status().released], [false, false, 0, 1]);
});

test("1.99add refix 3: an incognito OFF just before Pepe restarts un-hides once his first list after the restart lacks them - unlinked as well as linked; nothing is held for an owner (review C / H3)", async () => {
  await freshAll();
  const L = pepe();
  const fill = fillOf("h3f", 12);
  const [S, A] = ["strangercf", "alicecf"].map(H.hash);
  await L([S, A, ...fill], "c1");
  await I.sync({ items: [{ login: "strangercf", on: false, ts: L.now() + 100, via: "chat" }, { login: "AliceCF", on: false, ts: L.now() + 100, via: "chat" }] });
  assert.deepEqual(await L(fill, "c2"), { added: 0, removed: 2 }, "Pepe restarted before his next list: his first list after it, explained by their OFF");
  assert.deepEqual([QH("strangercf"), QH("alicecf"), H.status().held], [false, false, 0]);
});

test("1.99add refix 3: an owner looks a chat login up before deciding - its kinds, held (which batch), missing once; nothing changes; refix 4: every look-up is audited with the hash only (review P7)", async () => {
  await freshAll();
  const L = pepe();
  const [x, y, z] = ["xcf", "ycf", "zcf"].map(H.hash);
  const fill = fillOf("ck", 20);
  await L([x, y, z, ...fill], "k1");
  await L([y, z, ...fill], "k2");                       // Pepe restarted: x typed !bridge show just before it (or his file failed)
  await L([z, ...fill], "k2");                          // y: absent once
  await H.hiddenReported("zcf", L.now());
  const audits = async () => getQuery("SELECT * FROM admin_audit WHERE action = 'hubseam.check' ORDER BY id");
  const n0 = (await audits()).length;
  const [b] = H.status().held_batches;
  assert.deepEqual(await H.checkByOwner({ login: " @XCF " }, OWNER),
                   { h: x, hidden: true, left_out: true, kinds: [{ kind: "unknown", src: "pepe" }], absent_once: false, held: { id: b.id, kind: "restart", at: b.at } });
  assert.deepEqual((await H.checkByOwner({ login: "ycf" }, OWNER)).absent_once, true);
  assert.deepEqual(await H.checkByOwner({ h: z.toUpperCase() }, OWNER),
                   { h: z, hidden: true, left_out: true, kinds: [{ kind: "incognito", src: "report" }, { kind: "unknown", src: "pepe" }], absent_once: false, held: null });
  assert.deepEqual(await H.checkByOwner({ login: "nobody" }, OWNER), { h: H.hash("nobody"), hidden: false, left_out: false, kinds: [], absent_once: false, held: null });
  await assert.rejects(H.checkByOwner({ h: "zz" }, OWNER), (e) => e.refuse && e.code === "bad_key");
  await assert.rejects(H.checkByOwner({ login: "xcf" }, null), (e) => e.refuse && e.code === "owner_only");
  const a = await audits();
  assert.equal(a.length, n0 + 4, "each look-up leaves a trace (incognito hides WHO)");
  assert.deepEqual(a.slice(-4).map((r) => JSON.parse(r.detail)), [{ h: x }, { h: y }, { h: z }, { h: H.hash("nobody") }], "the hash only - never the login or the answer");
  assert.equal(H.status().held, 1, "...and changes nothing");
  assert.equal((await H.unhideByOwner({ login: "xcf" }, OWNER, "x asked: !bridge show before the restart")).held, "restart");
  assert.deepEqual([QH("xcf"), H.status().held], [false, 0]);
  H._reset();
  const orig = D.getQuery;
  D.getQuery = async (sql, params) => { if (/FROM hub_hidden_set/.test(sql)) throw new Error("SQLITE_BUSY"); return orig(sql, params); };
  try { await assert.rejects(H.checkByOwner({ login: "ycf" }, OWNER), (e) => e.refuse && e.status === 503 && e.code === "not_ready"); } finally { D.getQuery = orig; }
  assert.equal((await H.checkByOwner({ login: "ycf" }, OWNER)).hidden, true, "once it is back");
});

test("1.99add refix 3: an owner's approval or un-hide never un-hides a row Pepe hides again while it commits - it comes back with the next write (the review's nit)", async () => {
  await freshAll();
  const L = pepe();
  const fill = fillOf("n1f", 10);
  const [A, B, C] = ["acf", "bcf", "ccf"].map(H.hash);
  await L([A, B, C, ...fill], "n1");
  await L([C, ...fill], "n1");
  await L([C, ...fill], "n1");                          // A and B: held (mass)
  const [b] = H.status().held_batches;
  const AA = require(path.join(repo, "adminaudit"));
  const orig = AA.record;
  // the owner approves; while the transaction runs, Pepe's next list carries A again
  AA.record = async (...a) => { H.noteSync({ list: [A, C, ...fill], session: "n1", sent: new Date(L.now() + 10).toISOString() }); return orig(...a); };
  try { assert.deepEqual(await H.decideHeld(b.id, true, OWNER, "they asked"), { id: b.id, approved: true, removed: 1, still_hidden: 0 }); } finally { AA.record = orig; }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([QH("acf"), QH("bcf")], [true, false], "A stays hidden, B is un-hidden");
  assert.ok((await kept()).includes(A) && (await set()).includes(A), "A's rows are back (the set and the hub's copy)");
  assert.equal((await reader(A)).value, true, "the hub ends on hidden");
  // the same for an owner's un-hide by login: C's incognito is reported while it commits (only that kind comes back)
  AA.record = async (...a) => { H.hiddenReported("ccf", L.now() + 20); return orig(...a); };
  try { assert.equal((await H.unhideByOwner({ login: "ccf" }, OWNER, "testing")).was_hidden, true); } finally { AA.record = orig; }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(QH("ccf") && H.isHiddenHash(C), true, "C stays hidden");
  assert.deepEqual(await kindsDb(C), ["incognito"], "C's incognito row is back; his list's row went");
});

test("1.99add refix 3: the seam card lists every open held batch (not only 20); a site restart keeps Pepe's recent runs and each batch's two list times; older tables are migrated (held columns, the kinded set, the hub's scope)", async () => {
  await freshAll();
  const L = pepe();
  const keep = H.hash("keepcf");
  for (let i = 0; i < 25; i++) {
    await L([H.hash("r" + i + "cf"), keep], "run" + i);
    await L([keep], "run" + i + "b");                 // each restart loses one: 25 open batches
  }
  assert.deepEqual([H.status().held, H.status().held_batches.length], [25, 25], "all of them can be decided");
  // a mass batch, then a site restart: its two list times come back and Pepe's word between them still releases the last hash
  await freshAll();
  const L2 = pepe();
  const fill = fillOf("q1f", 10);
  const [A, B] = ["alicecf", "bobcf"].map(H.hash);
  await L2([A, B, ...fill], "q1");
  await L2([A, B, ...fill], "q2");                      // he restarted (nothing gone)
  const from = L2.now();
  await L2(fill, "q2");
  const first = L2.now();
  await L2(fill, "q2");                                 // A and B vanish: held
  await new Promise((r) => setTimeout(r, 30));
  const row = (await getQuery("SELECT prev_ts, sent_ts FROM hub_hidden_held WHERE state = 'pending'"))[0];
  assert.deepEqual([row.prev_ts, row.sent_ts], [from, first]);
  await restart();
  assert.deepEqual(await H.noteSync({ list: [], session: "q1", sent: new Date(first + 100).toISOString() }), { added: 0, removed: 0 },
                   "after the restart, a late post of his older run is still told apart: it only adds");
  assert.deepEqual([H.status().stale, H.status().held], [1, 2], "no new restart batch");
  await I.sync({ items: [{ login: "alicecf", on: false, ts: from + 500, via: "chat" }] });   // between the two lists; the report came late
  assert.deepEqual([QH("alicecf"), QH("bobcf"), H.status().held], [false, false, 0], "alice explained; bob is then a lone !bridge show");
  // the tables as the earlier 1.99add build made them: init() migrates them
  await runQuery("DROP TABLE hub_hidden_held");
  await runQuery(`CREATE TABLE hub_hidden_held (id TEXT PRIMARY KEY, kind TEXT NOT NULL, hs TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL,
                  relisted INTEGER NOT NULL DEFAULT 0, decided_at INTEGER, manual INTEGER NOT NULL DEFAULT 0)`);
  await runQuery("INSERT INTO hub_hidden_held (id, kind, hs, at, state) VALUES ('0123456789ab', 'mass', '[]', 1, 'pending')");
  await runQuery("DROP TABLE hub_hidden_set");
  await runQuery("CREATE TABLE hub_hidden_set (h TEXT PRIMARY KEY, since INTEGER NOT NULL, src TEXT NOT NULL)");
  const [o1, o2, o3] = ["mig1cf", "mig2cf", "mig3cf"].map(H.hash);
  await runQuery("INSERT INTO hub_hidden_set (h, since, src) VALUES (?, 1, 'pepe'), (?, 1, 'report'), (?, 1, 'web')", [o1, o2, o3]);
  await restart();
  const cols = (await getQuery("PRAGMA table_info(hub_hidden_held)")).map((c) => c.name);
  assert.ok(cols.includes("prev_ts") && cols.includes("sent_ts"));
  assert.deepEqual([await kindsDb(o1), await kindsDb(o2), await kindsDb(o3), await srcOf(o3)], [["unknown"], ["incognito"], ["incognito"], "web"],
                   "a row a list carried: unknown; one only a report / the website put there: incognito");
  assert.ok((await getQuery("PRAGMA table_info(hub_hidden_h)")).some((c) => c.name === "scope"));
  assert.equal(H.status().booted, true);
});

test("train2 + cl-site merge: ONE reader rule - quotes.isHidden (tips, mentions, boost, go-live, the mic stage) hides whom EITHER sticky set hides; an un-hide in this set alone names nobody while the pad chat archive's set still anonymises them, and Pepe's privacy.shown un-hides both", async () => {
  await fresh();
  const CL = require(path.join(repo, "chatlog"));
  await CL.init();
  const mh = H.hash("mergecf");
  const t0 = Date.now() - 60 * 1000;
  // an older Pepe's incognito ON report: both sets hide (incognito: "someone", never left out)
  await I.sync({ items: [{ login: "mergecf", on: true, ts: t0, via: "chat" }] });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual([QH("mergecf"), CL.hiddenKind(mh), Q.isHidden("mergecf"), Q.isLeftOut("mergecf")], [true, "anon", true, false]);
  // his OFF report: this set takes the incognito kind away; the archive's set keeps it (only privacy.shown un-hides there) -
  // so nothing names them yet: the chat still shows "someone", and tips / mentions / the mic stage agree
  await I.sync({ items: [{ login: "mergecf", on: false, ts: t0 + 1000, via: "chat" }] });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual([QH("mergecf"), CL.hiddenKind(mh)], [false, "anon"], "the two sets differ here");
  assert.deepEqual([Q.isHidden("mergecf"), Q.isPrivate("mergecf"), Q.isLeftOut("mergecf")], [true, true, false], "the stricter answer: still 'someone'");
  // Pepe's explicit un-hide (CL1 privacy.shown {scope: incognito}) reaches both: named again everywhere
  const shownEv = shown(mh, "incognito", t0 + 2000);
  await H.noteSync({ list: [], events: [shownEv], session: "merge", sent: new Date(t0 + 2500).toISOString(), explicit: true });
  await CL.noteSync({ events: [shownEv] });
  assert.deepEqual([QH("mergecf"), CL.hiddenKind(mh), Q.isHidden("mergecf")], [false, null, false]);
  // the archive's set while it loads hides everyone (fail closed) whatever this set says
  const kind = CL.hiddenKind;
  CL.hiddenKind = () => "out";
  try { assert.deepEqual([QH("strangercf"), Q.isHidden("strangercf"), Q.isLeftOut("strangercf")], [false, true, true]); }
  finally { CL.hiddenKind = kind; }
});
