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
