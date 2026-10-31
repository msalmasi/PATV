// Review fix (handoff 16): the people a 🎙 mic-stage capture draws (stagecap's stage_capture_people) follow the ACCOUNT that had the
// Camfrog login when the capture was made (stagecap.depictedOf: accountdelete.loginWindowsOf + micrec.othersMarks, merged accounts
// included) - the delete right, account deletion (published captures deleted with their saved copies / posts, unfinished ones
// stopped, the person's rows gone) and Download my data (their own references only). A recycled login's next holder gets none of it.
//   node --test test/micstage-people.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "micstage-people-test-"));
process.chdir(dir);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.MEDIA_DIR = path.join(dir, "media");
process.env.FEED_DIR = path.join(dir, "feed");
const repo = path.resolve(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

// the real schema (snapshot + every CREATE TABLE in the code), like test/account-delete.test.js
const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "twitchLogin TEXT", "auto_source TEXT", "displayname_auto INTEGER", "age_confirmed_at INTEGER", "age_confirmed_v TEXT", "text_style TEXT"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const H = 3600e3, NOW = Date.now();
const T = { capA: NOW - 5 * H, capA2: NOW - 4.5 * H, aliceLeft: NOW - 4 * H, bobLinked: NOW - 3 * H, capB: NOW - 2 * H, capC: NOW - H };
const CAP = { A: "c" + "a".repeat(20), A2: "c" + "b".repeat(20), B: "c" + "c".repeat(20), C: "c" + "d".repeat(20) };
const MID = { A: "aaaa0000aaaa0000", B: "bbbb0000bbbb0000", C: "cccc0000cccc0000" };
const U = { alice: { userId: "alice", username: "alice", class: "pleb" }, bob: { userId: "bob", username: "bob", class: "pleb" },
            dave: { userId: "dave", username: "dave", class: "pleb" } };
let runQuery, getQuery, D, X, SC, media;

/** A mic capture by carol drawing `people` (published as media `mid` when given). */
async function cap(id, state, created, mid, people) {
  await runQuery(`INSERT INTO stage_captures (id, user_id, username, room_id, source, slot_id, stream_label, kind, ct, state, media_id, created)
                  VALUES (?, 'carol', 'carol', 'Lab.Room', 'mic', NULL, '🎙 the mic', 'photo', 'image/webp', ?, ?, ?)`, [id, state, mid, created]);
  for (const l of people) await runQuery("INSERT INTO stage_capture_people (capture_id, login) VALUES (?, ?)", [id, l]);
  if (!mid) return;
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, source, stream, nsfw, by_user_id, slot_id)
                  VALUES (?, 'photo', 'image/webp', ?, 10, 0, '🎙 the mic', 'carol', 'Lab.Room', ?, ?, 0, 0, 'stage', 'mic', 0, 'carol', NULL)`, [mid, mid + ".webp", created, NOW + 24 * H]);
  fs.writeFileSync(path.join(media.DIR, mid + ".webp"), "fixture");
}

let setupP = null;
const setup = () => setupP || (setupP = (async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  D = require(path.join(repo, "accountdelete"));
  X = require(path.join(repo, "accountexport"));
  SC = require(path.join(repo, "stagecap"));
  media = require(path.join(repo, "media"));
  await D.init();
  await require(path.join(repo, "sessions")).init();
  await require(path.join(repo, "ledger")).ensure();
  await require(path.join(repo, "staleaccounts")).ensure();
  await SC.init();                                                        // + the people-row triggers
  SC._setDeps({ can: () => false, canManage: async () => false });
  const user = (id, cf) => runQuery(`INSERT INTO users (userId, username, displayname, email, password, class, camfrogUsername, points_balance, isEmailVerified)
                                     VALUES (?, ?, ?, ?, 'x', 'pleb', ?, 0, 1)`, [id, id, id, id + "@example.com", cf]);
  // alice had "sharedcf", let it go for "alicenew"; bob linked "sharedcf" after her (a recycled login); dave and carol are bystanders
  await user("alice", "alicenew"); await user("bob", "sharedcf"); await user("dave", "davecf"); await user("carol", "carolcf");
  await runQuery(`INSERT INTO login_changes (userId, old_login, new_login, old_key, new_key, at, via) VALUES
                  ('alice', 'sharedcf', 'alicenew', 'sharedcf', 'alicenew', ?, 'verify'), ('bob', NULL, 'sharedcf', 'u:bob', 'sharedcf', ?, 'verify')`, [T.aliceLeft, T.bobLinked]);
  await cap(CAP.A, "done", T.capA, MID.A, ["sharedcf", "davecf"]);          // alice (then "sharedcf") and dave
  await cap(CAP.A2, "preview", T.capA2, null, ["sharedcf"]);                // alice, an unfinished preview
  fs.writeFileSync(path.join(media.DIR, "stagecap-tmp", CAP.A2 + ".webp"), "preview");
  await cap(CAP.B, "done", T.capB, MID.B, ["sharedcf"]);                    // bob, after he linked the recycled login
  await cap(CAP.C, "done", T.capC, MID.C, ["alicenew"]);                    // alice under her login now
})());

test("the delete right: the person drawn when the capture was made - never the recycled login's next holder", async () => {
  await setup();
  const m = async (id) => (await getQuery("SELECT * FROM media WHERE id = ?", [id]))[0];
  assert.equal(await SC.canDelete(U.bob, await m(MID.A)), false, "bob holds 'sharedcf' now, but alice had it when this was made");
  assert.equal(await SC.canDelete(U.alice, await m(MID.A)), true, "alice keeps it under her new login");
  assert.equal(await SC.canDelete(U.dave, await m(MID.A)), true, "another person drawn in it");
  assert.equal(await SC.canDelete(U.bob, await m(MID.B)), true, "bob's own capture");
  assert.equal(await SC.canDelete(U.alice, await m(MID.B)), false, "made after alice let the login go");
  assert.equal(await SC.canDelete(U.alice, await m(MID.C)), true);
  // an account merged INTO dave had "mergedcf" until bob linked his: a capture of it then is dave's (micrec.holderIds)
  const capM = "c" + "e".repeat(20), midM = "eeee0000eeee0000";
  await runQuery("INSERT INTO account_merge_log (at, via, from_id, to_id) VALUES (1, 'test', 'mergedaway', 'dave')");
  await runQuery(`INSERT INTO login_changes (userId, old_login, new_login, old_key, new_key, at, via) VALUES ('mergedaway', 'mergedcf', NULL, 'mergedcf', 'u:mergedaway', ?, 'merge')`, [T.bobLinked]);
  await cap(capM, "done", T.capA, midM, ["mergedcf"]);
  try {
    assert.equal(await SC.canDelete(U.dave, await m(midM)), true, "the merged account's login is dave's");
    assert.equal(await SC.canDelete(U.bob, await m(midM)), false);
  } finally { await runQuery("DELETE FROM stage_captures WHERE id = ?", [capM]); await runQuery("DELETE FROM media WHERE id = ?", [midM]); }
});

test("Download my data: the account's own mic-capture references only - no capturer, no other people, no paths", async () => {
  await setup();
  const mine = (await X.collect("alice")).chat.mic_stage_captures_of_you;
  assert.deepEqual(mine.map((r) => [r.capture, r.login]), [[CAP.A, "sharedcf"], [CAP.A2, "sharedcf"], [CAP.C, "alicenew"]]);
  for (const r of mine) assert.deepEqual(Object.keys(r).sort(), ["capture", "created", "kind", "login", "media_id", "pad", "state"]);
  assert.ok(!JSON.stringify(mine).includes("davecf") && !JSON.stringify(mine).includes("carol"), "never the other people in it or who took it");
  assert.deepEqual((await X.collect("bob")).chat.mic_stage_captures_of_you.map((r) => r.capture), [CAP.B], "bob: only after he linked it");
});

test("account deletion: captures drawing the person go (saved copies + posts too), unfinished ones stop; the next holder's capture stays", async () => {
  await setup();
  // a saved copy and a post of capture A (defence in depth: storykeep refuses new ones for mic captures)
  await require(path.join(repo, "storykeep")).init();
  await runQuery("INSERT INTO story_keeps (capture_id, kind, ct, file, created) VALUES (?, 'image', 'image/webp', 'keepfile.webp', 1)", [MID.A]);
  await runQuery("INSERT INTO story_saves (user_id, capture_id, created, kind) VALUES ('dave', ?, 1, 'photo')", [MID.A]);
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created) VALUES (9901, 'carol', 'a mic snap', '', 1)");
  await runQuery("INSERT INTO story_posts (capture_id, post_id, room_id, author_id, posted_by, created, kind, source) VALUES (?, '9901', 'Lab.Room', 'carol', 'carol', 1, 'photo', 'stage')", [MID.A]);
  await D.schedule({ userId: "alice", username: "alice" });
  const r = await D.execute("alice", { force: true });
  assert.equal(r.state, "done", JSON.stringify(r));
  const del = async (id) => Number((await getQuery("SELECT deleted FROM media WHERE id = ?", [id]))[0].deleted);
  assert.deepEqual([await del(MID.A), await del(MID.C), await del(MID.B)], [1, 1, 0], "alice's two published captures go; bob's stays");
  assert.ok(!fs.existsSync(path.join(media.DIR, MID.A + ".webp")) && fs.existsSync(path.join(media.DIR, MID.B + ".webp")), "the files too");
  assert.equal(r.report.mic_captures_removed, 2);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [MID.A]))[0].n, 0, "the saved copy goes");
  assert.ok((await getQuery("SELECT purged_at FROM story_keeps WHERE capture_id = ?", [MID.A]))[0].purged_at);
  assert.ok((await getQuery("SELECT deleted_at FROM feed_posts WHERE id = 9901"))[0].deleted_at, "the post made from it is hidden");
  const a2 = (await getQuery("SELECT state FROM stage_captures WHERE id = ?", [CAP.A2]))[0];
  assert.equal(a2.state, "failed", "the unfinished preview drawing her is stopped");
  assert.ok(!fs.existsSync(path.join(media.DIR, "stagecap-tmp", CAP.A2 + ".webp")));
  assert.deepEqual((await getQuery("SELECT capture_id, login FROM stage_capture_people ORDER BY capture_id")).map((x) => [x.capture_id, x.login]),
                   [[CAP.B, "sharedcf"]], "no people row of hers (nor of the captures that went) is left - bob's stays");
});
