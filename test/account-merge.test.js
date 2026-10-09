// Account merges lose nothing (1.99gb): an old account with a row in EVERY user-linked table (the real schema,
// test/fixtures/schema.sql + the tables the code creates) is merged; everything lands on the target, collisions
// fold deterministically, and afterwards nothing references the old id except its account_archive snapshot and
// the account_merge_log row.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctmerge-"));
process.chdir(dir);                                      // dbUtils opens ./myapp.db
const repo = path.join(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

const OLD = "u-old-7f3a9c11", NEW = "u-new-2b8e4d22", THIRD = "u-third-9c1d0e33", FOURTH = "u-fourth-55aa01";
const NOW = 1760000000000;

// the real schema first (with its unique keys), then whatever the code creates that the snapshot lacks
const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  await new Promise((r) => db.close(r));
})();

let AM, stale, PM, runQuery, getQuery;
const ready = built.then(() => {
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  AM = require(path.join(repo, "accountMerge"));
  stale = require(path.join(repo, "staleaccounts"));
  PM = require(path.join(repo, "providermerge"));
});

let seq = 0;
const rnd = () => `v${++seq}x${Math.random().toString(36).slice(2, 8)}`;
async function cols(t) { return getQuery("SELECT name, type, \"notnull\" AS nn, dflt_value AS d, pk FROM pragma_table_info(?)", [t]); }
async function tables() {
  return (await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name);
}
/** Insert one row into `t` with `vals` fixed and filler everywhere else. -> true when it went in. */
async function seedRow(t, vals) {
  const C = await cols(t);
  const names = [], args = [];
  for (const c of C) {
    let v;
    if (Object.prototype.hasOwnProperty.call(vals, c.name)) v = vals[c.name];
    else if (c.pk && /INT/i.test(c.type) && C.filter((x) => x.pk).length === 1) continue;     // rowid
    else if (/INT|REAL|NUM|BOOL/i.test(c.type)) v = c.d != null && !c.nn ? undefined : 1 + (++seq % 7);
    else v = rnd();
    if (v === undefined) continue;
    names.push(`"${c.name}"`); args.push(v);
  }
  const r = await runQuery(`INSERT OR IGNORE INTO "${t}" (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, args).catch((e) => ({ err: e.message }));
  return !!(r && r.changes);
}
async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, password, email, isEmailVerified, points_balance, xp, level, liked, avatar, created_at)
                  VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [id, o.username || id, o.email || null, o.verified ? 1 : 0, o.bal || 0, o.xp || 0, o.level || 0, o.liked || 0,
                  o.avatar || "avatar.png", o.created || "2026-01-01 00:00:00"]);
}

// every text column in the database that still mentions the old id (outside the archive + merge log)
async function referencesTo(id) {
  const out = [];
  for (const t of await tables()) {
    if (t === "account_archive" || t === "account_merge_log" || t === "account_merges") continue;   // the records of the merge
    for (const c of await cols(t)) {
      const n = (await getQuery(`SELECT COUNT(*) AS n FROM "${t}" WHERE instr(CAST("${c.name}" AS TEXT), ?) > 0`, [id]))[0].n;
      if (n) out.push(`${t}.${c.name} x${n}`);
    }
  }
  return out;
}

test("a merge moves a row from EVERY user-linked table, folds collisions, and leaves nothing on the old id", async () => {
  await ready;
  await user(OLD, { username: "oldie", bal: 5000, xp: 700, level: 3, liked: 4, avatar: "https://x/old.png", created: "2025-01-01 00:00:00",
                    email: "old@example.org", verified: true });
  await user(NEW, { username: "newbie", bal: 100, xp: 50, level: 5, liked: 1, email: "placeholder-no-at" });
  await user(THIRD, { username: "third" }); await user(FOURTH, { username: "fourth" });

  // 1) generic: one row per user column of every table, the column = OLD, filler elsewhere
  const seeded = [];
  const failed = [];
  for (const { table, column, rule } of await AM.discover()) {
    if (rule && (rule.deny || rule.keep)) continue;
    if (table === "rooms_kv") { await runQuery("INSERT INTO rooms_kv (key, value) VALUES ('seeded:somepad', ?)", [OLD]); seeded.push([table, column]); continue; }
    (await seedRow(table, { [column]: OLD })) ? seeded.push([table, column]) : failed.push(`${table}.${column}`);
  }
  assert.deepStrictEqual(failed, [], "every user column could be seeded");
  assert.ok(seeded.length > 120, `seeded ${seeded.length} user columns`);
  // room columns: the old account's profile pad
  await runQuery(`INSERT INTO rooms_registry (room_id, slug, title, owner_kind, owner_user_id, platform, created, updated)
                  VALUES (?, 'u-oldie', 'u/oldie', 'user', ?, 'profile', 1, 1)`, ["user:" + OLD, OLD]);
  await runQuery("INSERT INTO rooms_kv (key, value) VALUES (?, 'profile')", ["seeded:user:" + OLD]);
  const roomSeeded = [];
  for (const t of await tables()) {
    if (t === "rooms_registry") continue;
    for (const c of await cols(t)) if (AM.ROOM_COLUMNS.test(c.name) && (await seedRow(t, { [c.name]: "user:" + OLD }))) roomSeeded.push(`${t}.${c.name}`);
  }
  await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES (?, 'room', ?, 5)", [THIRD, "user:" + OLD]);

  // 2) collisions, each resolved deterministically
  await runQuery("INSERT INTO badges (badgeId, points) VALUES ('b1', 10)").catch(() => {});
  await runQuery("INSERT INTO user_badges (userId, badgeId, awardedAt) VALUES (?, 'b1', '2025-02-02'), (?, 'b1', '2026-03-03')", [OLD, NEW]);
  await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES (?, 'user', ?, 100), (?, 'user', ?, 200), (?, 'user', ?, 300)",
                 [OLD, THIRD, NEW, THIRD, OLD, NEW]);                                           // both follow third; old follows new
  await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES (?, 'user', ?, 10), (?, 'user', ?, 20)",
                 [FOURTH, OLD, FOURTH, NEW]);                                                   // fourth follows both
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)", [OLD, NEW]);
  await runQuery("INSERT INTO feed_posts (id, author_id, body, created) VALUES ('P1', ?, 'hello', 1)", [THIRD]).catch(() => seedRow("feed_posts", { id: "P1", author_id: THIRD }));
  await runQuery("INSERT INTO feed_votes (post_id, user_id, value, created) VALUES ('P1', ?, 1, 1), ('P1', ?, -1, 2)", [OLD, NEW])
    .catch(async () => { await seedRow("feed_votes", { post_id: "P1", user_id: OLD, value: 1 }); await seedRow("feed_votes", { post_id: "P1", user_id: NEW, value: -1 }); });
  await runQuery("INSERT OR REPLACE INTO levelup_rewards (userId, level, amount, paid) VALUES (?, 2, 25000, 1), (?, 2, 25000, 0)", [OLD, NEW]);
  await runQuery("INSERT OR REPLACE INTO welcome_bonus (userId, state, created, connect_owed) VALUES (?, 'paid', 1000, 0), (?, 'pending', 2000, 1)", [OLD, NEW]);
  await runQuery("INSERT INTO pad_members (room_id, user_id, status) VALUES ('padX', ?, 'approved'), ('padX', ?, 'pending')", [OLD, NEW]);
  await runQuery("INSERT INTO inbox_prefs (user_id, kind) VALUES (?, 'dm'), (?, 'dm')", [OLD, NEW]).catch(() => {});
  // DMs: old<->third and new<->third (one conversation after), old<->new (notes), a group with both
  const conv = async (id, kind, key, members) => {
    await runQuery("INSERT INTO conversations (id, kind, dm_key, created_by, created_at) VALUES (?, ?, ?, ?, 1)", [id, kind, key, members[0]]);
    for (const [m, role] of members.map((m, i) => [m, i === 0 && kind === "group" ? "owner" : "member"])) {
      await runQuery("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_id) VALUES (?, ?, ?, 1, 0)", [id, m, role]);
    }
  };
  await conv("C_ot", "dm", [OLD, THIRD].sort().join("|"), [OLD, THIRD]);
  await conv("C_nt", "dm", [NEW, THIRD].sort().join("|"), [NEW, THIRD]);
  await conv("C_on", "dm", [OLD, NEW].sort().join("|"), [OLD, NEW]);
  await conv("C_g", "group", null, [OLD, NEW, THIRD]);
  for (const [c, s, b] of [["C_ot", OLD, "hi from old"], ["C_ot", THIRD, "hi old"], ["C_nt", NEW, "hi from new"], ["C_on", OLD, "note to self"]]) {
    await runQuery("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, 1)", [c, s, b]);
  }

  // 3) the merge (the duplicate path - it shares every step with the Twitch / Discord merge)
  const r = await stale.mergeDuplicate(OLD, NEW);
  assert.ok(r, "merged");
  assert.deepStrictEqual(r.report.unclassified, [], "nothing unclassified");
  assert.deepStrictEqual(r.report.left, {}, "nothing left on the old id");

  // nothing references the old id any more, except the archive + merge log
  assert.deepStrictEqual(await referencesTo(OLD), []);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM users WHERE userId = ?", [OLD]))[0].n, 0);
  // every seeded column has its row on the target now
  const lost = [];
  for (const [t, c] of seeded) if (!(await getQuery(`SELECT COUNT(*) AS n FROM "${t}" WHERE "${c}" = ?`, [NEW]))[0].n) lost.push(`${t}.${c}`);
  // (dm_blocks: old's "blocks new" row was the self-block; its generic row moved fine)
  assert.deepStrictEqual(lost, [], "every user column's row reached the target");
  const lostRooms = [];
  for (const k of roomSeeded) { const [t, c] = k.split("."); if (!(await getQuery(`SELECT COUNT(*) AS n FROM "${t}" WHERE "${c}" = ?`, ["user:" + NEW]))[0].n) lostRooms.push(k); }
  assert.deepStrictEqual(lostRooms, [], "the profile pad's rows moved to the target's pad");
  assert.equal((await getQuery("SELECT owner_user_id FROM rooms_registry WHERE room_id = ?", ["user:" + NEW]))[0].owner_user_id, NEW, "the old pad became the target's");

  // users row: xp added, higher level, liked added, older created_at, the avatar and the VERIFIED email
  const u = (await getQuery("SELECT * FROM users WHERE userId = ?", [NEW]))[0];
  assert.equal(u.xp, 750); assert.equal(u.level, 5); assert.equal(u.liked, 5);
  assert.equal(u.created_at, "2025-01-01 00:00:00"); assert.equal(u.avatar, "https://x/old.png");
  assert.equal(u.email, "old@example.org"); assert.equal(u.isEmailVerified, 1);

  // collisions
  const b = await getQuery("SELECT * FROM user_badges WHERE userId = ? AND badgeId = 'b1'", [NEW]);
  assert.equal(b.length, 1); assert.equal(b[0].awardedAt, "2025-02-02", "the earliest award date");
  const f = await getQuery("SELECT * FROM follows WHERE follower = ? AND target_kind = 'user' AND target_id = ?", [NEW, THIRD]);
  assert.equal(f.length, 1); assert.equal(f[0].created_at, 100, "the earlier follow");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM follows WHERE follower = ? AND target_id = ?", [NEW, NEW]))[0].n, 0, "no self-follow");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM follows WHERE follower = ? AND target_kind = 'user' AND target_id = ?", [FOURTH, NEW]))[0].n, 1, "fourth follows the target once");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM follows WHERE follower = ? AND target_kind = 'room' AND target_id = ?", [THIRD, "user:" + NEW]))[0].n, 1, "a pad follow follows the pad");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?", [NEW, NEW]))[0].n, 0, "no self-block");
  const v = await getQuery("SELECT * FROM feed_votes WHERE post_id = 'P1'");
  assert.equal(v.length, 1); assert.equal(v[0].user_id, NEW); assert.equal(v[0].value, -1, "the target's own vote stays");
  const lr = await getQuery("SELECT * FROM levelup_rewards WHERE userId = ? AND level = 2", [NEW]);
  assert.equal(lr.length, 1); assert.equal(lr[0].paid, 1, "a level reward either account was paid stays paid");
  const wb = (await getQuery("SELECT * FROM welcome_bonus WHERE userId = ?", [NEW]))[0];
  assert.equal(wb.state, "paid", "the welcome is once per person: the paid one wins"); assert.equal(wb.created, 1000);
  assert.equal((await getQuery("SELECT status FROM pad_members WHERE room_id = 'padX' AND user_id = ?", [NEW]))[0].status, "approved");
  // DMs
  const dm = await getQuery("SELECT * FROM conversations WHERE dm_key = ?", [[NEW, THIRD].sort().join("|")]);
  assert.equal(dm.length, 1, "one conversation with third");
  const bodies = (await getQuery("SELECT body FROM messages WHERE conversation_id = ? ORDER BY id", [dm[0].id])).map((m) => m.body);
  assert.deepStrictEqual(bodies.sort(), ["hi from new", "hi from old", "hi old"].sort(), "both histories in it");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?", [dm[0].id]))[0].n, 2);
  const notes = (await getQuery("SELECT * FROM conversations WHERE id = 'C_on'"))[0];
  assert.equal(notes.kind, "group"); assert.equal(notes.dm_key, null);
  assert.equal((await getQuery("SELECT body FROM messages WHERE conversation_id = 'C_on'"))[0].body, "note to self", "kept");
  const g = await getQuery("SELECT * FROM conversation_members WHERE conversation_id = 'C_g' AND user_id = ?", [NEW]);
  assert.equal(g.length, 1); assert.equal(g[0].role, "owner", "the old account's group ownership carried");

  // the record
  const a = (await getQuery("SELECT * FROM account_archive WHERE userId = ?", [OLD]))[0];
  assert.equal(a.tier, "MERGE");
  const snap = JSON.parse(a.snapshot);
  assert.equal(snap.username, "oldie"); assert.equal(snap.merged_into, NEW);
  for (const k of Object.keys(snap)) assert.ok(!/password|email|token|reset|secret|streamkey/i.test(k), `no ${k} in the snapshot`);
  const log = (await getQuery("SELECT * FROM account_merge_log WHERE from_id = ?", [OLD]))[0];
  assert.equal(log.to_id, NEW); assert.equal(log.via, "duplicate");
  const moved = JSON.parse(log.moved);
  assert.ok(moved["transactions.userId"] >= 1 && moved["feed_posts.author_id"] >= 1 && moved["follows.follower"] >= 1, "per-table counts");
  assert.ok(Object.keys(moved).length > 100, `${Object.keys(moved).length} table.columns counted`);
});

test("Twitch / Discord merge: posts, follows, DMs, stories and badges come along; merge log + archive written", async () => {
  await ready;
  const A = "u-provold-11", B = "u-provnew-22", C = "u-provother-33";
  await user(A, { username: "provold", bal: 700 }); await user(B, { username: "provnew" }); await user(C, { username: "provother" });
  await runQuery("UPDATE users SET twitchId = 'T-777' WHERE userId = ?", [A]);
  await seedRow("feed_posts", { id: "PP1", author_id: A });
  await seedRow("feed_comments", { id: "PC1", author_id: A, post_id: "PP1" });
  await seedRow("story_posts", { capture_id: "S1", author_id: A });
  await seedRow("user_badges", { userId: A, badgeId: "b1" });
  await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES (?, 'user', ?, 1), (?, 'user', ?, 2)", [A, C, C, A]);
  await runQuery("INSERT INTO conversations (id, kind, dm_key, created_by, created_at) VALUES ('PC', 'dm', ?, ?, 1)", [[A, C].sort().join("|"), A]);
  await runQuery("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('PC', ?, 1), ('PC', ?, 1)", [A, C]);
  const L = { label: "Twitch", idCol: "twitchId", nameCol: "twitchDisplayname", otherIdCol: "discordId", otherNameCol: "discordUsername" };
  const r = await PM.mergeProviderAccount({ provider: "twitch", L, fromId: A, toId: B, linkId: "T-777", linkName: "Prov" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.amount, 700);
  assert.deepStrictEqual(await referencesTo(A), []);
  for (const [t, c] of [["feed_posts", "author_id"], ["feed_comments", "author_id"], ["story_posts", "author_id"], ["user_badges", "userId"]]) {
    assert.equal((await getQuery(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [B]))[0].n >= 1, true, `${t}.${c}`);
  }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM follows WHERE (follower = ? AND target_id = ?) OR (follower = ? AND target_id = ?)", [B, C, C, B]))[0].n, 2, "both directions");
  assert.equal((await getQuery("SELECT dm_key FROM conversations WHERE id = 'PC'"))[0].dm_key, [B, C].sort().join("|"));
  const log = (await getQuery("SELECT * FROM account_merge_log WHERE from_id = ?", [A]))[0];
  assert.ok(log && log.via === "twitch link" && log.pat === 700);
  assert.equal((await getQuery("SELECT tier FROM account_archive WHERE userId = ?", [A]))[0].tier, "MERGE");
});
