// Offline tests for 🧠 "Make Pepe forget me" (pepeforget.js, 1.99aat): only the member's 1:1 conversation with Pepe is
// wiped (both sides, like a deleted message), other conversations untouched; Pepe gets the "privacy.forgetme" action;
// three a day; Pepe's own call after !forgetme confirm wipes the DMs of every account linked to that login.
//   node --test test/pepeforget.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepeforget-test-"));
process.chdir(tmp);
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const M = require(path.join(repo, "messages"));
const PF = require(path.join(repo, "pepeforget"));
const actions = require(path.join(repo, "actions"));

let T = 1_800_000_000_000;
PF._setClock(() => T);
const queued = [];
actions.queue = async (uid, a) => { queued.push({ uid, ...a }); return "act" + queued.length; };

async function conv(id, a, b) {
  await runQuery("INSERT INTO conversations (id, kind, dm_key, created_by, created_at) VALUES (?, 'dm', ?, ?, ?)", [id, [a, b].sort().join("|"), a, T]);
  for (const u of [a, b]) await runQuery("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)", [id, u, T]);
}
async function msg(c, from, body) {
  await runQuery("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)", [c, from, body, T]);
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, camfrogUsername TEXT, class TEXT)`);
  await runQuery("INSERT INTO users (userId, username, camfrogUsername) VALUES ('u1', 'alice', 'alicecf'), ('u2', 'bob', NULL), ('u3', 'alice_alt', 'alicecf')");
  await M.init();
  await conv("c-pepe", "u1", PF.PEPE_ID);
  await conv("c-bob", "u1", "u2");
  await conv("c-alt", "u3", PF.PEPE_ID);
  await msg("c-pepe", "u1", "my secret");
  await msg("c-pepe", PF.PEPE_ID, "ribbit, noted");
  await msg("c-bob", "u1", "hi bob");
  await msg("c-alt", "u3", "alt secret");
});

test("the website request: the DMs with Pepe go (both sides), others stay; Pepe is asked to forget", async () => {
  const r = await PF.request("u1");
  assert.equal(r.dms, 2);
  const rows = await getQuery("SELECT conversation_id, body, deleted_at, deleted_by FROM messages ORDER BY id");
  for (const m of rows.filter((x) => x.conversation_id === "c-pepe")) {
    assert.equal(m.body, null);
    assert.ok(m.deleted_at);
    assert.equal(m.deleted_by, "forget");
  }
  assert.equal(rows.find((x) => x.conversation_id === "c-bob").body, "hi bob", "a conversation with someone else is untouched");
  assert.equal(rows.find((x) => x.conversation_id === "c-alt").body, "alt secret", "another account's DMs are untouched");
  assert.deepEqual(queued.map((q) => [q.uid, q.kind]), [["u1", "privacy.forgetme"]]);
  assert.equal((await PF.last("u1")).via, "web");
});

test("three a day", async () => {
  await PF.request("u1");
  await PF.request("u1");
  await assert.rejects(PF.request("u1"), (e) => e.code === "rate");
  T += 24 * 3600 * 1000 + 1;
  assert.equal((await PF.request("u1")).ok, true);
});

test("Pepe's call after !forgetme confirm: every account linked to that login", async () => {
  const r = await PF.fromBot("AliceCF");
  assert.equal(r.accounts, 2);
  assert.equal(r.dms, 1, "the alt's message (the main account's were already gone)");
  assert.equal((await getQuery("SELECT body FROM messages WHERE conversation_id = 'c-alt'"))[0].body, null);
  assert.equal((await PF.fromBot("nobody-here")).accounts, 0);
  assert.equal((await PF.fromBot("bad name!")).ok, false);
});
