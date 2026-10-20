// storyreact site: account deletion with story reactions (accountdelete.js on a full schema - the account-delete test's harness):
// their story votes and the story references of the replies they sent go, references ABOUT them are unlinked (other people's
// cards turn "Story no longer available"), story_tips stay (ledger evidence, like post_tips), story_prefs go.
//   NODE_PATH=G:/PATV/node_modules node --test test/story-react-lifecycle.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storyreact-life-"));
process.chdir(dir);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.MEDIA_DIR = path.join(dir, "mediafiles");
const repo = path.resolve(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "twitchLogin TEXT", "auto_source TEXT", "displayname_auto INTEGER", "age_confirmed_at INTEGER", "age_confirmed_v TEXT"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await run("ALTER TABLE story_prefs ADD COLUMN capture_reacts INTEGER NOT NULL DEFAULT 1").catch(() => {});
  await new Promise((r) => db.close(r));
})();

let D, S, runQuery, getQuery;
const DAY = 86400000;
let clockAt = Date.UTC(2026, 9, 19, 12);
const reqOf = (uid, sid = null) => ({ user: { userId: uid }, loginSession: sid ? { id: sid, userId: uid } : null });

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  D = require(path.join(repo, "accountdelete"));
  S = require(path.join(repo, "sessions"));
  D._setClock(() => clockAt);
  S._setClock(() => clockAt);
  await D.init();
  await S.init();
  await require(path.join(repo, "ledger")).ensure();
  await require(path.join(repo, "staleaccounts")).ensure();
});

test("the deletion job: story votes + sent story refs deleted, refs about them unlinked, story tips kept, story prefs gone", async () => {
  const bcrypt = require("bcrypt");
  const add = (id, name, cf, pw) => runQuery(`INSERT INTO users (userId, username, displayname, email, password, class, camfrogUsername, points_balance, isEmailVerified)
                                              VALUES (?, ?, ?, ?, ?, 'pleb', ?, 0, 1)`, [id, name, name, id + "@example.com", pw || "x", cf]);
  await add("gone", "goner", "gonercf", await bcrypt.hash("pw-12345678", 4));
  await add("oth", "otherperson", "othercf");
  await runQuery("INSERT INTO story_votes (story_id, user_id, value, w, created, updated) VALUES ('5a0000aa', 'gone', 1, 1, 1, 1), ('5a0000aa', 'oth', 1, 1, 1, 1)");
  await runQuery(`INSERT INTO story_tips (story_id, sender_id, recipient_id, amount, note, role, ref, created) VALUES
                  ('5a0000aa', 'gone', 'oth', 7, 'hi', 'uploader', 'l1', 1), ('5a0000ab', 'oth', 'gone', 9, 'yo', 'subject', 'l2', 1)`);
  await runQuery(`INSERT INTO dm_story_refs (message_id, conversation_id, story_id, sender_id, author_id, role, author_name, room_title, created) VALUES
                  (801, 'c1', '5a0000aa', 'gone', 'oth', 'uploader', 'Other', 'A Pad', 1), (802, 'c1', '5a0000ab', 'oth', 'gone', 'subject', 'Goner Cam', 'A Pad', 1)`);
  await runQuery("INSERT INTO story_prefs (user_id, captures_of_me, capture_reacts, updated) VALUES ('gone', 1, 0, 1)");
  const fresh = await S.create({ get: () => "" }, "gone", "password");
  await D.request(reqOf("gone", fresh.id), { password: "pw-12345678", confirm: "goner" });
  clockAt += 14 * DAY + 1;
  await D.tick();
  const row = (await getQuery("SELECT * FROM account_deletions WHERE user_id = 'gone'"))[0];
  assert.equal(row.state, "done", JSON.stringify(row));
  assert.deepEqual((await getQuery("SELECT user_id FROM story_votes ORDER BY user_id")).map((x) => x.user_id), ["oth"], "their vote went, the other one stayed");
  assert.deepEqual((await getQuery("SELECT message_id FROM dm_story_refs ORDER BY message_id")).map((x) => x.message_id), [802], "the refs of replies they sent went");
  assert.deepEqual((await getQuery("SELECT author_id, author_name FROM dm_story_refs WHERE message_id = 802"))[0], { author_id: null, author_name: null },
                   "a reply to their story: unlinked (its card reads Story no longer available)");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_tips"))[0].n, 2, "story tips are kept");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_prefs WHERE user_id = 'gone'"))[0].n, 0);
  const rep = JSON.parse(row.report || "{}");
  assert.equal(rep.story_refs_unlinked, 1);
});
