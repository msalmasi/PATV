// 1.99abh: who may delete a capture made in Camfrog (!snap / !clip - media.source NULL): the person who took it (their linked
// chat name = the by_login Pepe sent), the person in it (subject_login), the pad's managers and staff; nobody else.
//   node --test test/capture-delete.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "capdel-test-")));
const C = require(path.join(__dirname, "..", "stagecap"));
C._setDeps({ can: (u, key) => key === "pads.manage_any" && u.class === "Admin", canManage: async (u, room) => u.userId === "u-owner" && room === "PepeFrog.Room" });

const cap = { id: "abcdef0123456789", source: null, room: "PepeFrog.Room", by_login: "ritchiecuh", subject_login: "alice" };
const u = (id, cf, cls) => ({ userId: id, username: id, camfrogUsername: cf, class: cls || "pleb" });

test("the person who took it, the person in it, the pad's managers and staff may delete; nobody else", async () => {
  assert.equal(await C.canDelete(u("u1", "RitchieCuh"), cap), true, "the requester (linked chat name, any case)");
  assert.equal(await C.canDelete(u("u2", "alice"), cap), true, "the person in it");
  assert.equal(await C.canDelete(u("u-owner", "boss"), cap), true, "the pad's owner / mods");
  assert.equal(await C.canDelete(u("u-admin", null, "Admin"), cap), true, "staff");
  assert.equal(await C.canDelete(u("u3", "someoneelse"), cap), false, "another member");
  assert.equal(await C.canDelete(u("u4", null), cap), false, "an account with no chat name");
  assert.equal(await C.canDelete(u("u1", "ritchiecuh"), { ...cap, by_login: null, subject_login: null }), false,
    "an older capture Pepe sent without logins: managers / staff only");
});

test("a depicted mic participant may delete through their current linked login; covers and unrelated names confer no access", async () => {
  const { runQuery, getQuery } = require(path.join(__dirname, "..", "dbUtils"));
  await runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT, displayname TEXT, class TEXT, camfrogUsername TEXT)");
  await runQuery("INSERT INTO users (userId, username, class, camfrogUsername) VALUES ('depicted', 'viewer', 'pleb', 'FiXtUrEcAm'), ('other', 'fixturecam', 'pleb', 'elsewhere')");
  await C.init();
  const mid = "deadbeef12345678", cid = "c12345678901234567890", now = Date.now();
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, source, stream, slot_id, by_user_id)
    VALUES (?, 'photo', 'image/webp', 'mic-fixture.webp', 10, 0, '🎙 the mic', 'capturer', 'PepeFrog.Room', ?, ?, 0, 'stage', 'mic', NULL, 'maker')`, [mid, now, now + 3600000]);
  await runQuery(`INSERT INTO stage_captures (id, user_id, username, room_id, source, stream_label, kind, ct, state, media_id, created)
    VALUES (?, 'maker', 'capturer', 'PepeFrog.Room', 'mic', '🎙 the mic', 'photo', 'image/webp', 'done', ?, ?)`, [cid, mid, now]);
  await runQuery("INSERT INTO stage_capture_people (capture_id, login) VALUES (?, 'fixturecam')", [cid]);
  const m = (await getQuery("SELECT * FROM media WHERE id = ?", [mid]))[0];
  assert.equal(await C.canDelete(u("depicted", "stale-session-name"), m), true, "current linked account is authoritative, ignoring stale session names");
  assert.equal(await C.canDelete(u("other", "fixturecam"), m), false, "a display name or forged/stale session name is not a link");
  assert.equal(await C.canDelete(u("maker", null), m), true);
  assert.equal(await C.canDelete(u("u-owner", null), m), true);
  assert.equal(await C.canDelete(u("admin", null, "Admin"), m), true);
  await assert.rejects(C.remove(u("other", "fixturecam"), mid), e => e.status === 403 && e.i18n === "stagecap.mic.delete_denied");
  await C.remove(u("depicted", null), mid);
  assert.equal((await getQuery("SELECT deleted FROM media WHERE id = ?", [mid]))[0].deleted, 1);
  assert.deepEqual(await getQuery("SELECT * FROM stage_capture_people WHERE capture_id = ?", [cid]), []);
});
