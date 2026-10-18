// 1.99acm hubhidden.js: Pepe's hidden_h kept for the chat hub - only the difference is written (one transaction), invalid values
// and non-arrays ignored, the 5,000 cap, calls serialised (the newest waiting list wins), the privacy/changed "hh:" trigger rows
// while hubseam.privacy is on, the bridge sync never waits for it.
//   node --test test/hubhidden.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "hubhidden-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const H = require(path.join(repo, "hubhidden"));
const HO = require(path.join(repo, "huboutbox"));

const set = async () => (await getQuery("SELECT h FROM hub_hidden_h ORDER BY h")).map((r) => r.h);
const h = (i) => String(i).padStart(20, "0").replace(/[^0-9a-f]/g, "a");

test.before(async () => { await HO.init(); await HO.setSettings({ privacy: true }); });

test("the hash is quotes.hiddenHash's; loginHash only for the logins the hub accepts", () => {
  assert.equal(H.hash(" Alice "), require(path.join(repo, "quotes")).hiddenHash("alice"));
  assert.equal(H.loginHash("x$y"), H.hash("x$y"));
  assert.equal(H.loginHash("zoë"), null);
  assert.equal(H.loginHash("a".repeat(41)), null);
  assert.equal(H.loginHash(null), null);
});

test("diffs: only the difference is written; a non-array is ignored; invalid values dropped; the cap", async () => {
  assert.deepEqual(await H.note(undefined), { ignored: true });
  assert.deepEqual(await H.note("nope"), { ignored: true });
  assert.deepEqual(await H.note([h(1), h(2), "XYZ", 5, h(2)]), { added: 2, removed: 0 });
  assert.deepEqual(await set(), [h(1), h(2)]);
  const since1 = (await getQuery("SELECT since FROM hub_hidden_h WHERE h = ?", [h(1)]))[0].since;
  assert.deepEqual(await H.note([h(2), h(1)]), { added: 0, removed: 0 }, "same set (any order): nothing written");
  assert.deepEqual(await H.note([h(2), h(3)]), { added: 1, removed: 1 });
  assert.deepEqual(await set(), [h(2), h(3)]);
  assert.deepEqual(await H.note([]), { added: 0, removed: 2 }, "an empty list: nobody hidden");
  const big = Array.from({ length: H.MAX + 50 }, (_, i) => (i + 1).toString(16).padStart(20, "0"));
  assert.equal((await H.note(big)).added, H.MAX);
  assert.equal((await set()).length, H.MAX);
  await H.note([h(1)]);
  assert.ok((await getQuery("SELECT since FROM hub_hidden_h WHERE h = ?", [h(1)]))[0].since >= since1);
});

test("serialised: lists arriving during a write wait, and only the newest of them is written", async () => {
  await H.note([]);
  const a = H.note([h(4)]);
  const b = H.note([h(5)]);
  const c = H.note([h(6)]);
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.deepEqual(ra, { added: 1, removed: 0 });
  assert.deepEqual(rb, { superseded: true });
  assert.deepEqual(rc, { added: 1, removed: 1 });
  assert.deepEqual(await set(), [h(6)]);
});

test("1.99acm: nothing is stored while hubseam.privacy is off; switching it off empties the set (no rows); on again: the whole set", async () => {
  await H.note([h(1), h(2)]);
  await runQuery("DELETE FROM hub_outbox");
  await HO.setSettings({ privacy: false });
  assert.deepEqual(await set(), [], "switching the feed off drops Pepe's set from the database");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox"))[0].n, 0, "...without telling the hub (the switch is off)");
  assert.deepEqual(await H.note([h(7)]), { ignored: true }, "off: ignored");
  assert.deepEqual(await set(), [], "off: not stored (the bridge sync calls note() whatever the switches say)");
  await HO.setSettings({ privacy: true });
  assert.deepEqual(await H.note([h(1), h(2)]), { added: 2, removed: 0 }, "the first sync after the switch turns on writes the whole set");
});

test("the trigger: privacy/changed hh: rows for each added / removed hash while hubseam.privacy is on", async () => {
  await HO.setSettings({ privacy: false });
  await runQuery("DELETE FROM hub_outbox");
  await HO.setSettings({ privacy: true });
  await H.note([h(7), h(8)]);
  await H.note([h(8)]);
  const r = await getQuery("SELECT topic, entity, payload FROM hub_outbox ORDER BY id");
  assert.deepEqual(r, [{ topic: "privacy/changed", entity: "hh:" + h(7), payload: null }, { topic: "privacy/changed", entity: "hh:" + h(8), payload: null },
                       { topic: "privacy/changed", entity: "hh:" + h(7), payload: null }]);
});

test("bridge.js hands Pepe's list over without waiting (a logged catch)", () => {
  const src = fs.readFileSync(path.join(repo, "bridge.js"), "utf8");
  assert.match(src, /require\("\.\/hubhidden"\)\.note\(body\.hidden_h\)\.catch\(/);
  assert.ok(!/await require\("\.\/hubhidden"\)/.test(src), "the sync answer never waits for it");
});
