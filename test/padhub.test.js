// S1-D1 (ADR 0007 D2): padhub.js - every pad gets a random lower-case UUIDv4 hub pad id, from the rooms_registry insert
// trigger (any writer) or the start-up backfill, never recomputed, and it moves with the pad on a re-key (padrekey.js's
// generic room_id move; a merge keeps the moving pad's id).
//   node --test test/padhub.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "padhub-test-"));
process.chdir(dir);
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));
const built = (async () => {                     // the real schema (a staging dump + every CREATE in the source)
  const db = new (require("sqlite3").Database)(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  await new Promise((r) => db.close(r));
})();
let runQuery, getQuery, PH, RK, rooms;

const reg = (id, slug) => runQuery("INSERT INTO rooms_registry (room_id, slug, title, created, updated) VALUES (?, ?, ?, 1, 1)", [id, slug, slug]);

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  PH = require(path.join(repo, "padhub"));
  RK = require(path.join(repo, "padrekey"));
  rooms = require(path.join(repo, "rooms"));
});

test("registry rows that predate the table are backfilled; new rows get an id from the trigger; ids are v4 and stable", async () => {
  await rooms.init();
  await reg("patv:old1", "old-one");
  await PH.init();
  const a = await PH.of("patv:old1");
  assert.match(a, PH.UUID4_RE, "backfilled at start-up");
  await reg("patv:new1", "new-one");
  const b = await PH.of("patv:new1");
  assert.match(b, PH.UUID4_RE, "the insert trigger (SQL v4)");
  assert.notEqual(a, b);
  for (let i = 0; i < 40; i++) await reg("patv:bulk" + i, "bulk-" + i);
  const all = await getQuery("SELECT hub_pad_id FROM pad_hub");
  assert.ok(all.every((r) => PH.UUID4_RE.test(r.hub_pad_id)), "every SQL-minted id is a valid v4 (version and variant nibbles)");
  assert.equal(new Set(all.map((r) => r.hub_pad_id)).size, all.length, "unique");
  assert.equal(await PH.backfill(), 0, "nothing to backfill twice");
  await runQuery("UPDATE rooms_registry SET title = 'x', slug = 'new-one-b' WHERE room_id = 'patv:new1'");
  assert.equal(await PH.of("patv:new1"), b, "never recomputed");
  const m = await PH.ofRooms(["patv:old1", "patv:new1", "patv:nope"]);
  assert.deepEqual([...m.keys()].sort(), ["patv:new1", "patv:old1"]);
});

test("a re-key moves the pad's id with it; a merge keeps the moving pad's id", async () => {
  const id = await PH.of("patv:old1");
  await RK.rekey("patv:old1", "roomA");
  assert.equal(await PH.of("roomA"), id, "connect: the site pad's id follows it to the room id");
  assert.equal(await PH.of("patv:old1"), null);
  await reg("roomB", "room-b");                               // the room's own (unowned) pad, with its own id
  const theirs = await PH.of("roomB");
  const mine = await PH.of("patv:new1");
  assert.notEqual(theirs, mine);
  await RK.rekey("patv:new1", "roomB");
  assert.equal(await PH.of("roomB"), mine, "UPDATE OR REPLACE: the moving pad's id wins");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pad_hub WHERE hub_pad_id = ?", [theirs]))[0].n, 0, "the displaced id is gone (Q4 emits it)");
});

test("a pad's deletion drops its hub id in the same transaction; a pad re-created under the room id is a new pad", async () => {
  const { tx } = require(path.join(repo, "dbUtils"));
  await reg("roomC", "room-c");
  const first = await PH.of("roomC");
  assert.match(first, PH.UUID4_RE);
  await require(path.join(repo, "padcreate")).removePad("roomC");
  assert.equal(await PH.of("roomC"), null, "padcreate.removePad: the row went with the registry row");
  await reg("roomC", "room-c");
  const second = await PH.of("roomC");
  assert.match(second, PH.UUID4_RE);
  assert.notEqual(second, first, "a new pad to the hub, never the old one revived");
  // padconnect's connect: the room's own pad is deleted, then the site pad is re-keyed onto the room's id
  await reg("patv:site2", "site-two");
  const site = await PH.of("patv:site2");
  await runQuery("DELETE FROM rooms_registry WHERE room_id = 'roomC'");
  await RK.rekey("patv:site2", "roomC");
  assert.equal(await PH.of("roomC"), site, "the site pad keeps its id at the room's address");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pad_hub WHERE hub_pad_id = ?", [second]))[0].n, 0, "the room's own pad's id is gone");
  // the same transaction as the DELETE: a deletion that rolls back keeps the id
  await reg("roomD", "room-d");
  const d = await PH.of("roomD");
  await assert.rejects(tx(async () => { await runQuery("DELETE FROM rooms_registry WHERE room_id = 'roomD'"); throw new Error("a later step failed"); }));
  assert.equal(await PH.of("roomD"), d, "rolled back with the registry row");
});
