// 1.99aon: a pad's FORMER room ids in the owner sync's retention_keep block (micrec.formerRooms / keepBlock; with camfrog-bot 1.99aoo
// pepe_retention). The owner, 2026-11-17: "Fix PepeFrog.Room which is now TheNewSpot so it isn't deleted. It will also get a new room in
// the future." - Pepe files his history under the Camfrog room id it was made in; a house rotation moves the house pad to a new id, and
// the old ids left the registry ("no tier" for Pepe after their grace). Here, with made-up ids shaped like prod's three 2026-11-11
// rotations (the shared fixture test/fixtures/retention-former-wire.json, byte-identical with the bot's ci/fixtures copy):
//   * every rotation that carried the chat archive along names its old id -> the pad's id now, until when it moved (the journal's `at`;
//     house_room.prev's day for an id the journal lacks); a rotation that LEFT the archive (archive "keep") isn't one; a login-only /
//     rename row isn't either; the current id never is
//   * an older Pepe (bot < 1.99aoo reads only tiers / held_rooms): each former id nobody's pad uses now rides in `tiers` at the pad's tier
//     and lapses ("via"), and the former ids of a held pad join held_rooms; an id somebody's pad has now gets neither (its own data)
//   * a room that really lost its tier (Lapsed_Room) is unchanged; the pad losing Plus takes its former ids with it (their lapse rides);
//     a future rotation (NewSpot.Room -> Next.Room) needs nothing by hand: every old id then points at Next.Room
//   * over FORMER_MAX: not complete (Pepe deletes nothing); a journal row without a result counts as a move; the owner sync carries
//     the block; the admin card counts them
//   NODE_PATH=G:/PATV/node_modules node --test test/micrec-former.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "micrec-former-test-"));
process.chdir(dir);
delete process.env.STAGING;
delete process.env.STAGE_DEFAULT_ROOM;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
const repo = path.resolve(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));
const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "twitchLogin TEXT", "auto_source TEXT", "displayname_auto INTEGER", "age_confirmed_at INTEGER", "age_confirmed_v TEXT", "text_style TEXT"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await new Promise((r) => db.close(r));
})();

// the shared wire fixture (camfrog-bot tools/gen_retention_former_wire.py writes it; byte-identical with the bot's
// ci/fixtures/retention-former-wire.json). Update together with its pin there (retention_former_test.py PIN).
const WIRE_PIN = "987e6c49a3badc92f3978655807cc3d491c83e507ce4cbeaf159f9ce65144181";
const WIRE_RAW = fs.readFileSync(path.join(__dirname, "fixtures", "retention-former-wire.json"));
const FX = JSON.parse(WIRE_RAW.toString("utf8"));
const DAY = 86400000;
let clockAt = FX.now_ms;
let M, P, R, runQuery, getQuery, server, base;

let setupP = null;
const setup = () => setupP || (setupP = (async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  M = require(path.join(repo, "micrec"));
  P = require(path.join(repo, "premium"));
  R = require(path.join(repo, "rooms"));
  const CL = require(path.join(repo, "chatlog"));
  for (const x of [M, P]) x._setClock(() => clockAt);
  await P.init();
  await CL.init();
  await R.init();
  await M.init();
  // the fixture's site rows (made-up ids, shaped like prod's 2026-11-11 rotations)
  const S = FX.site_rows;
  for (const [id, slug, title, owner] of S.rooms_registry) {
    await runQuery("INSERT OR REPLACE INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES (?, ?, ?, ?, 'camfrog', 1, 1)", [id, slug, title, owner]);
  }
  await runQuery("INSERT OR REPLACE INTO rooms_kv (key, value) VALUES ('house_room', ?)", [JSON.stringify(S.house_room)]);
  for (const [id, key, from, to, at, result] of S.house_rotations) {
    await runQuery("INSERT INTO house_rotations (id, key, from_id, to_id, at, actor, before, result) VALUES (?, ?, ?, ?, ?, 'pepe', '{}', ?)", [id, key, from, to, at, JSON.stringify(result)]);
  }
  for (const [tier, target, how] of S.premium_subs) {
    await runQuery("INSERT INTO premium_subs (tier, target, paid_through, comped, status, started, updated) VALUES (?, ?, 0, ?, 'active', 1, 1)", [tier, target, how === "comped" ? 1 : 0]);
  }
  for (const [rk, id] of S.chatlog_rooms) await runQuery("INSERT INTO chatlog_rooms (rk, room_id, created) VALUES (?, ?, 1)", [rk, id]);
  for (const [id, rec] of Object.entries(S.chatlog_meta_tiers)) await runQuery("INSERT INTO chatlog_meta (key, value) VALUES (?, ?)", ["tier:" + id, JSON.stringify(rec)]);
  for (const k of S.chatlog_holds) await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, 'staff', 'test hold', 1)", [k]);
  await P.loadCache();
  await R.loadCache();
  const express = require("express");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-user"); req.user = u ? { userId: u, username: u, class: req.get("x-class") || "pleb" } : null; next(); };
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  M.register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
})());
test.after(() => { if (server) { if (server.closeAllConnections) server.closeAllConnections(); server.close(); } });

test("the shared wire fixture (pinned in both repos): the keep block the site builds from its rows is the one Pepe's test reads", async () => {
  await setup();
  assert.equal(crypto.createHash("sha256").update(WIRE_RAW).digest("hex"), WIRE_PIN, "regenerate in camfrog-bot (tools/gen_retention_former_wire.py) and re-pin BOTH repos");
  assert.ok(!WIRE_RAW.includes(Buffer.from("\r\n")), "LF line ends");
  if (process.env.PEPE_BOT_DIR) {
    const p = path.join(process.env.PEPE_BOT_DIR, "ci", "fixtures", "retention-former-wire.json");
    assert.ok(fs.existsSync(p) && fs.readFileSync(p).equals(WIRE_RAW), "the bot's copy is byte-identical");
  }
  M._resetCache();
  const b = await M.keepBlock({ fresh: true });
  assert.deepEqual(b, FX.block, JSON.stringify(b));
});

test("formerRooms: rotations that carried the archive, the journal's moment, prev for the rest; kept / login-only rows and the current id never", async () => {
  await setup();
  const fr = await M.formerRooms();
  const by = Object.fromEntries(fr.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(by).sort(), ["Ancient.Room", "FrogHome.Room", "Frog_Home.Room", "Swampy"]);
  for (const x of fr) assert.equal(x.to, "NewSpot.Room", "every one points at the pad's id NOW");
  assert.equal(by["FrogHome.Room"].until, FX.site_rows.house_rotations[1][4], "the journal's moment, not the prev day");
  assert.equal(by["Ancient.Room"].until, Date.UTC(2026, 6, 1), "prev only: the end of its until day (UTC)");
  assert.equal(by["KeptHome.Room"], undefined, "a rotation that LEFT the archive under the old id: no pad's former room (the owner's choice)");
  assert.equal(by["NewSpot.Room"], undefined, "the current id (and a login-only row) never");
  const b = await M.keepBlock({ fresh: true });
  // an older Pepe's copies: only the ids nobody's pad has now, at the pad's tier, marked via
  assert.deepEqual(Object.keys(b.tiers).filter((k) => b.tiers[k].via).sort(), ["FrogHome.Room", "Frog_Home.Room", "Swampy"]);
  assert.equal(b.tiers["Ancient.Room"], undefined, "somebody's pad now: its own data keeps its own rules");
  assert.deepEqual(b.tiers.Lapsed_Room, { tier: "standard", lapsed: [{ tier: "prime", at: FX.now_ms - 5 * DAY }] }, "a room that really lost its tier: as before");
  assert.deepEqual(b.held_rooms, ["NewSpot.Room", "FrogHome.Room", "Swampy", "Frog_Home.Room"], "the held pad's unregistered former ids are held too");
  assert.ok(!JSON.stringify(b).includes("Kept"), "nothing of the kept one");
});

test("the owner sync carries former_rooms; the admin card counts them (grace rooms leave the via copies out)", async () => {
  await setup();
  M._resetCache();
  const r = await fetch(`${base}/api/rooms/owners`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot" }) });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d).slice(0, 300));
  assert.deepEqual(d.retention_keep.former_rooms, FX.block.former_rooms);
  assert.equal(d.retention_keep.ok, true);
  const card = await (await fetch(`${base}/api/admin/micrec`, { headers: { "x-user": "boss", "x-class": "Admin" } })).json();
  assert.equal(card.keep.former_rooms, 4);
  assert.equal(card.keep.grace_rooms, 1, "Lapsed_Room only");
});

test("the pad loses Plus: its former ids ride at its new tier with its lapse (never longer than the pad); then a future rotation needs nothing by hand", async () => {
  await setup();
  const t0 = clockAt;
  // the house pad's Plus comp ends 2 days ago (the chat archive's tier tracking would say the same)
  await runQuery("UPDATE premium_subs SET comp_until = ?, status = 'active' WHERE target = 'NewSpot.Room'", [t0 - 2 * DAY]);
  await P.loadCache();
  M._resetCache();
  let b = await M.keepBlock({ fresh: true });
  assert.equal(b.ok, true);
  const lap = [{ tier: "unlimited", at: t0 - 2 * DAY }];
  assert.deepEqual(b.tiers["NewSpot.Room"], { tier: "standard", lapsed: lap }, "the pad's own lapse");
  for (const id of ["FrogHome.Room", "Swampy", "Frog_Home.Room"]) assert.deepEqual(b.tiers[id], { tier: "standard", lapsed: lap, via: "NewSpot.Room" }, id);
  // 40 days on: the pad's grace is over - its former ids keep nothing extra (a standard tier without a lapse isn't sent)
  clockAt = t0 + 40 * DAY;
  M._resetCache();
  b = await M.keepBlock({ fresh: true });
  for (const id of ["FrogHome.Room", "Swampy", "Frog_Home.Room"]) assert.equal(b.tiers[id], undefined, id);
  assert.equal(b.former_rooms["FrogHome.Room"][0].to, "NewSpot.Room", "the alias itself stays (Pepe follows the pad's tier: none now)");
  // Plus back; then the NEXT rotation - the journal row and house_room the rotation writes are all it takes
  clockAt = t0;
  await runQuery("UPDATE premium_subs SET comp_until = NULL WHERE target = 'NewSpot.Room'");
  const t4 = t0 + 3600e3;
  await runQuery("INSERT INTO house_rotations (id, key, from_id, to_id, at, actor, before, result) VALUES (6, 'rot-e', 'NewSpot.Room', 'Next.Room', ?, 'pepe', '{}', ?)",
                 [t4, JSON.stringify({ mode: "move", archive: "moved", archive_rk: 1 })]);
  const h = { ...FX.site_rows.house_room, id: "Next.Room", since: t4, prev: [...FX.site_rows.house_room.prev, { id: "NewSpot.Room", title: "The New Place", slug: "the-new-place", until: "2027-03-31" }] };
  await runQuery("UPDATE rooms_kv SET value = ? WHERE key = 'house_room'", [JSON.stringify(h)]);
  await runQuery("UPDATE rooms_registry SET room_id = 'Next.Room' WHERE room_id = 'NewSpot.Room'");
  await runQuery("UPDATE premium_subs SET target = 'Next.Room' WHERE target = 'NewSpot.Room'");
  await runQuery("UPDATE chatlog_rooms SET room_id = 'Next.Room' WHERE rk = 1");
  await P.loadCache();
  M._resetCache();
  b = await M.keepBlock({ fresh: true });
  assert.equal(b.ok, true);
  assert.deepEqual(Object.keys(b.former_rooms).sort(), ["Ancient.Room", "FrogHome.Room", "Frog_Home.Room", "NewSpot.Room", "Swampy"]);
  for (const v of Object.values(b.former_rooms)) assert.equal(v[0].to, "Next.Room");
  assert.equal(b.former_rooms["NewSpot.Room"][0].until, t4);
  for (const id of ["FrogHome.Room", "Swampy", "Frog_Home.Room", "NewSpot.Room"]) assert.deepEqual(b.tiers[id], { tier: "unlimited", lapsed: [], via: "Next.Room" }, id);
  assert.deepEqual(b.held_rooms.slice().sort(), ["FrogHome.Room", "Frog_Home.Room", "NewSpot.Room", "Next.Room", "Swampy"]);
  // back to the fixture's rows for the other tests
  await runQuery("DELETE FROM house_rotations WHERE id = 6");
  await runQuery("UPDATE rooms_kv SET value = ? WHERE key = 'house_room'", [JSON.stringify(FX.site_rows.house_room)]);
  await runQuery("UPDATE rooms_registry SET room_id = 'NewSpot.Room' WHERE room_id = 'Next.Room'");
  await runQuery("UPDATE premium_subs SET target = 'NewSpot.Room' WHERE target = 'Next.Room'");
  await runQuery("UPDATE chatlog_rooms SET room_id = 'NewSpot.Room' WHERE rk = 1");
  await P.loadCache();
  M._resetCache();
  assert.deepEqual(await M.keepBlock({ fresh: true }), FX.block);
});

test("over FORMER_MAX former ids: not complete (Pepe deletes nothing); a journal row without a result still counts as a move", async () => {
  await setup();
  await runQuery(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
                  INSERT INTO house_rotations (id, key, from_id, to_id, at, actor, before, result)
                  SELECT 1000 + i, 'bulk-' || i, 'Bulk' || i || '.Room', 'NewSpot.Room', 1, 'pepe', '{}', '{"archive":"moved"}' FROM n`, [M.FORMER_MAX + 1]);
  M._resetCache();
  const big = await M.keepBlock({ fresh: true });
  assert.equal(big.complete, false);
  assert.equal(big.ok, false, "Pepe deletes nothing");
  await runQuery("DELETE FROM house_rotations WHERE id > 1000");
  M._resetCache();
  assert.equal((await M.keepBlock({ fresh: true })).ok, true);
  // only a result that SAYS the archive was kept leaves an id out - a row without one (NULL / unreadable) counts as a move (keeps more)
  await runQuery("INSERT INTO house_rotations (id, key, from_id, to_id, at, actor, before, result) VALUES (900, 'rot-null', 'NullRes.Room', 'Swampy', 5, 'pepe', '{}', NULL)");
  assert.ok((await M.formerRooms()).some((x) => x.id === "NullRes.Room" && x.to === "NewSpot.Room" && x.until === 5));
  await runQuery("DELETE FROM house_rotations WHERE id = 900");
  M._resetCache();
});
