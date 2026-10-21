// 1.99acf deploy/refresh-staging-db.sh + deploy/keep-staging-tables.js: a fresh copy of prod must not hand staging prod's
// per-environment tables. Staging keeps its own bot keys, key / seam switches, usage logs and bridge spans (a table prod
// doesn't have yet is created from staging's own statement; columns are matched by name), prod's hub_outbox rows are dropped
// and staging's id sequence carries on; if keeping fails the copy is cleared instead; the script runs it only after
// staging is stopped and throws the copy away when it can't be made safe.
//   node --test test/refresh-staging-keep.test.js      (temp DB files)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const sqlite3 = require(require.resolve("sqlite3", { paths: [repo] }));
const K = require(path.join(repo, "deploy", "keep-staging-tables"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-keep-"));

function db(file) { return new sqlite3.Database(file); }
const run = (d, sql, a = []) => new Promise((res, rej) => d.run(sql, a, function (e) { if (e) rej(e); else res(this); }));
const all = (d, sql, a = []) => new Promise((res, rej) => d.all(sql, a, (e, r) => (e ? rej(e) : res(r))));
const close = (d) => new Promise((res) => d.close(() => res()));

const SCHEMA = {
  bot_keys: "CREATE TABLE bot_keys (caller TEXT PRIMARY KEY, hash TEXT NOT NULL, tag TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]', mode TEXT NOT NULL DEFAULT 'observe', label TEXT, created_at INTEGER NOT NULL, observe_since INTEGER NOT NULL)",
  bot_keys_settings: "CREATE TABLE bot_keys_settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)",
  bot_key_families: "CREATE TABLE bot_key_families (family TEXT PRIMARY KEY, legacy_enforce INTEGER NOT NULL DEFAULT 0, updated INTEGER, actor TEXT)",
  hubseam_settings: "CREATE TABLE hubseam_settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)",
  legacy_token_daily: "CREATE TABLE legacy_token_daily (day TEXT NOT NULL, token TEXT NOT NULL, caller_hint TEXT NOT NULL, family TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL, PRIMARY KEY (day, token, caller_hint, family))",
  events_auth_log: "CREATE TABLE events_auth_log (day TEXT NOT NULL, type TEXT NOT NULL, chan TEXT NOT NULL, auth TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, type, chan, auth))",
  hub_outbox: "CREATE TABLE hub_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, entity TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL, posted_at INTEGER, dedupe_key TEXT)",
  hub_hidden_h: "CREATE TABLE hub_hidden_h (h TEXT PRIMARY KEY, since INTEGER NOT NULL, scope TEXT)",
  // 1.99add: the sticky hidden set (kept: prod's hidden people stay hidden on staging), the list compared with and held batches (emptied)
  // (refix 4: one row per kind - bridge | incognito | unknown)
  hub_hidden_set: "CREATE TABLE hub_hidden_set (h TEXT NOT NULL, kind TEXT NOT NULL, since INTEGER NOT NULL, src TEXT NOT NULL, PRIMARY KEY (h, kind))",
  hub_hidden_meta: "CREATE TABLE hub_hidden_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL)",
  hub_hidden_held: "CREATE TABLE hub_hidden_held (id TEXT PRIMARY KEY, kind TEXT NOT NULL, hs TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, relisted INTEGER NOT NULL DEFAULT 0, decided_at INTEGER, manual INTEGER NOT NULL DEFAULT 0, prev_ts INTEGER, sent_ts INTEGER)",
};

async function makeProd(file, { withKeyTables = true } = {}) {
  const d = db(file);
  await run(d, "CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT)");
  await run(d, "INSERT INTO users VALUES ('u1', 'prod-user')");
  if (withKeyTables) {
    for (const t of ["bot_keys", "bot_keys_settings", "bot_key_families", "hubseam_settings", "legacy_token_daily", "events_auth_log", "hub_outbox", "hub_hidden_h",
                     "hub_hidden_set", "hub_hidden_meta", "hub_hidden_held"]) await run(d, SCHEMA[t]);
    await run(d, "INSERT INTO hub_hidden_h (h, since) VALUES ('0123456789abcdef0123', 1)");   // 1.99acm: prod's Pepe's hidden set
    await run(d, "INSERT INTO hub_hidden_set (h, kind, since, src) VALUES ('0123456789abcdef0123', 'bridge', 1, 'pepe')");   // 1.99add: the sticky set
    await run(d, "INSERT INTO hub_hidden_meta (key, value, updated) VALUES ('last', '{\"session\":\"prodsess\"}', 1)");
    await run(d, "INSERT INTO hub_hidden_held (id, kind, hs, at, state) VALUES ('0123456789ab', 'restart', '[]', 1, 'pending')");
    await run(d, "INSERT INTO bot_keys (caller, hash, tag, created_at, observe_since) VALUES ('pepe', 'PROD-HASH', 'prodtag', 1, 1)");
    await run(d, "INSERT INTO bot_keys_settings (key, value) VALUES ('events', 'enforce'), ('bad_key', 'refuse')");
    await run(d, "INSERT INTO bot_key_families (family, legacy_enforce) VALUES ('/api/bridge', 1)");
    await run(d, "INSERT INTO hubseam_settings (key, value) VALUES ('sessions', 'true')");
    await run(d, "INSERT INTO legacy_token_daily (day, token, caller_hint, family, n) VALUES ('2026-10-01', 'shared', 'prod-hint', '/api/x', 9)");
    await run(d, "INSERT INTO events_auth_log (day, type, chan, auth, n) VALUES ('2026-10-01', 'spin', 'public', 'anon', 4)");
    for (let i = 0; i < 3; i++) await run(d, "INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('sessions/revoked', ?, 1)", ["sid:prod" + i]);
  }
  await close(d);
}
async function makeStaging(file) {
  const d = db(file);
  await run(d, "CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT)");
  for (const t of ["bot_keys", "bot_keys_settings", "hubseam_settings", "legacy_token_daily", "hub_outbox"]) await run(d, SCHEMA[t]);
  await run(d, "ALTER TABLE bot_keys ADD COLUMN extra TEXT");                       // staging a release ahead: a column prod lacks
  await run(d, "INSERT INTO bot_keys (caller, hash, tag, created_at, observe_since, extra) VALUES ('pepe', 'STG-HASH', 'stgtag', 2, 2, 'x')");
  await run(d, "INSERT INTO bot_keys_settings (key, value) VALUES ('events', 'observe')");
  await run(d, "INSERT INTO hubseam_settings (key, value) VALUES ('tickets', 'true')");
  await run(d, "INSERT INTO legacy_token_daily (day, token, caller_hint, family, n) VALUES ('2026-10-02', 'shared', 'staging-hint', '/api/x', 2)");
  for (let i = 0; i < 40; i++) await run(d, "INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('sessions/revoked', ?, 1)", ["sid:stg" + i]);
  await run(d, "DELETE FROM hub_outbox WHERE id > 30");                            // the staging hub has seen ids up to 40
  await close(d);
}

test("staging keeps its own keys, switches and logs; prod's go; hub_outbox is emptied and its ids carry on above staging's", async () => {
  const prod = path.join(dir, "copy1.db"), stg = path.join(dir, "staging1.db");
  await makeProd(prod); await makeStaging(stg);
  const r = await K.main(stg, prod, sqlite3);
  assert.equal(r.mode, "kept");
  const d = db(prod);
  try {
    assert.deepEqual(await all(d, "SELECT caller, hash, extra FROM bot_keys"), [{ caller: "pepe", hash: "STG-HASH", extra: "x" }],
                     "staging's key back, with the column only staging has");
    assert.deepEqual(await all(d, "SELECT key, value FROM bot_keys_settings"), [{ key: "events", value: "observe" }], "prod's events = enforce / bad_key = refuse gone");
    assert.deepEqual(await all(d, "SELECT * FROM bot_key_families"), [], "prod's legacy-enforce switch gone (staging Pepe isn't locked out)");
    assert.deepEqual(await all(d, "SELECT key, value FROM hubseam_settings"), [{ key: "tickets", value: "true" }]);
    assert.deepEqual(await all(d, "SELECT caller_hint FROM legacy_token_daily"), [{ caller_hint: "staging-hint" }], "staging's own usage history");
    assert.deepEqual(await all(d, "SELECT * FROM events_auth_log"), [], "a log staging didn't have: prod's rows still go");
    assert.deepEqual(await all(d, "SELECT * FROM hub_outbox"), [], "prod's unposted rows never reach the staging hub");
    assert.deepEqual(await all(d, "SELECT * FROM hub_hidden_h"), [], "prod's hidden set goes (staging's Pepe repopulates it)");
    assert.deepEqual(await all(d, "SELECT h, kind FROM hub_hidden_set"), [{ h: "0123456789abcdef0123", kind: "bridge" }], "1.99add: the sticky set stays prod's (hidden on prod = hidden on staging), with its kinds");
    assert.deepEqual(await all(d, "SELECT * FROM hub_hidden_meta"), [], "prod's Pepe's last list goes (staging's Pepe is another run)");
    assert.deepEqual(await all(d, "SELECT * FROM hub_hidden_held"), [], "prod's held batches go (prod's owner decides them)");
    await run(d, "INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('sessions/revoked', 'sid:new', 3)");
    const id = (await all(d, "SELECT id FROM hub_outbox"))[0].id;
    assert.ok(id > 40, `the next id (${id}) is above every id staging handed out (40)`);
    assert.deepEqual(await all(d, "SELECT username FROM users"), [{ username: "prod-user" }], "the data itself is prod's");
    assert.equal((await all(d, "PRAGMA journal_mode"))[0].journal_mode, "delete", "no -wal file left beside the copy");
  } finally { await close(d); }
  assert.ok(!fs.existsSync(prod + "-wal"));
});

test("prod without the new tables (staging deployed first): staging's are created in the copy, not dropped", async () => {
  const prod = path.join(dir, "copy2.db"), stg = path.join(dir, "staging2.db");
  await makeProd(prod, { withKeyTables: false }); await makeStaging(stg);
  const r = await K.main(stg, prod, sqlite3);
  assert.equal(r.mode, "kept");
  const d = db(prod);
  try {
    assert.deepEqual(await all(d, "SELECT caller, hash FROM bot_keys"), [{ caller: "pepe", hash: "STG-HASH" }]);
    assert.deepEqual(await all(d, "SELECT key FROM hubseam_settings"), [{ key: "tickets" }]);
    await run(d, "INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('x', 'y', 1)");
    assert.ok((await all(d, "SELECT id FROM hub_outbox"))[0].id > 40, "the sequence carries on in a table created from staging's");
  } finally { await close(d); }
});

test("when keeping fails, prod's per-environment rows are cleared instead (staging starts on safe defaults)", async () => {
  const prod = path.join(dir, "copy3.db");
  await makeProd(prod);
  const r = await K.main(path.join(dir, "no-such-dir", "missing.db"), prod, sqlite3);
  assert.equal(r.mode, "cleared");
  const d = db(prod);
  try {
    for (const t of ["bot_keys", "bot_keys_settings", "bot_key_families", "hubseam_settings", "legacy_token_daily", "events_auth_log", "hub_outbox", "hub_hidden_h"]) {
      assert.deepEqual(await all(d, `SELECT * FROM ${t}`), [], t + " cleared");
    }
    assert.deepEqual(await all(d, "SELECT username FROM users"), [{ username: "prod-user" }]);
  } finally { await close(d); }
});

test("the lists cover every per-environment table, and the script runs it with staging stopped (or keeps the old DB)", () => {
  assert.deepEqual([...K.KEEP].sort(), ["bot_key_families", "bot_keys", "bot_keys_settings", "bot_route_log", "bridge_spans", "events_auth_log",
                                         "hubseam_settings", "legacy_token_daily", "legacy_token_use",
                                         // CL2: the pad chat archive (chatlog.js TABLES - test/chatlog-guards.test.js keeps the two in step)
                                         "chatlog_rooms", "chat_log", "chatlog_hidden", "chatlog_tx_hidden", "chatlog_private_ever", "chatlog_hidden_held",
                                         "chatlog_hidden_names", "pad_chat_cfg", "chatlog_open", "chatlog_reports", "chatlog_holds", "chatlog_views",
                                         "chatlog_exports", "chatlog_meta",
                                         // CL2 fix-up: the live feed's tables (the archive's seed reads bridge_feed)
                                         "bridge_rooms", "bridge_feed",
                                         "pad_hub",
                                         // S1 Q4: staging's own CHAT_HUB
                                         "chat_switches"].sort(), "S1-D1: staging keeps its own hub pad ids; S1 Q4: and its own chat switches");
  assert.deepEqual(K.LIVE_FEED, ["bridge_rooms", "bridge_feed"]);
  assert.deepEqual(K.EMPTY, ["hub_hidden_h", "hub_hidden_meta", "hub_hidden_held", "hub_inbound_nonces", "hub_outbox"], "the outbox last (prod's triggers fire on the others)");
  const sh = fs.readFileSync(path.join(repo, "deploy", "refresh-staging-db.sh"), "utf8");
  const stop = sh.indexOf("pm2 stop patv-staging"), keep = sh.indexOf("keep-staging-tables.js"), swap = sh.indexOf('mv "$S/myapp.db.new" "$S/myapp.db"');
  assert.ok(stop > 0 && keep > stop && swap > keep, "stop -> keep -> swap");
  assert.match(sh, /if ! node "\$\(dirname "\$0"\)\/keep-staging-tables\.js" "\$S\/myapp\.db" "\$S\/myapp\.db\.new"; then[\s\S]{0,300}rm -f "\$S\/myapp\.db\.new"[\s\S]{0,120}pm2 start patv-staging[\s\S]{0,40}exit 1/,
               "a copy that can't be made safe is thrown away and staging restarted on its old DB");
  assert.ok(!/DELETE FROM bot_keys;/.test(sh), "the old bot_keys-only handling is gone");
  // 1.99acm: prod's unfinished exports never run on staging
  assert.match(sh, /if has_table account_exports; then sqlite3 "\$S\/myapp\.db\.new" "UPDATE account_exports SET state = 'expired', file = NULL WHERE state IN \('queued', 'running'\);"; fi/);
  assert.ok(sh.indexOf("UPDATE account_exports") < sh.indexOf("pm2 stop patv-staging"), "scrubbed in the copy before staging ever opens it");
});

test("1.99acm: prod's real hh trigger can't leak prod's hidden hashes into staging's emptied outbox (staging's privacy switch on)", async () => {
  const prod = path.join(dir, "copy4.db"), stg = path.join(dir, "staging4.db");
  await makeProd(prod); await makeStaging(stg);
  // the copy carries prod's triggers exactly as huboutbox.init creates them (whatever prod's switches say)
  const ms = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  const gate = "(SELECT value FROM hubseam_settings WHERE key = 'privacy') = 'true'";
  const p = db(prod);
  for (const [ev, ref] of [["INSERT", "NEW"], ["DELETE", "OLD"]]) {
    await run(p, `CREATE TRIGGER hub_outbox_hh_${ev.toLowerCase()} AFTER ${ev} ON hub_hidden_h WHEN ${gate}
                  BEGIN INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('privacy/changed', 'hh:' || ${ref}.h, ${ms}); END`);
  }
  await close(p);
  const s = db(stg);
  await run(s, "INSERT INTO hubseam_settings (key, value) VALUES ('privacy', 'true')");   // staging's privacy feed is on
  await close(s);
  const r = await K.main(stg, prod, sqlite3);
  assert.equal(r.mode, "kept");
  const d = db(prod);
  try {
    assert.deepEqual(await all(d, "SELECT key, value FROM hubseam_settings ORDER BY key"), [{ key: "privacy", value: "true" }, { key: "tickets", value: "true" }]);
    assert.deepEqual(await all(d, "SELECT * FROM hub_hidden_h"), []);
    assert.deepEqual(await all(d, "SELECT topic, entity FROM hub_outbox"), [], "no prod hash waits to be posted to the staging hub");
  } finally { await close(d); }
  // and the fallback clears in the same safe order
  await makeProd(path.join(dir, "copy5.db"));
  const p5 = db(path.join(dir, "copy5.db"));
  await run(p5, "UPDATE hubseam_settings SET value = 'true' WHERE key = 'sessions'");
  await run(p5, "INSERT INTO hubseam_settings (key, value) VALUES ('privacy', 'true')");
  await run(p5, `CREATE TRIGGER hub_outbox_hh_delete AFTER DELETE ON hub_hidden_h WHEN ${gate}
                 BEGIN INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('privacy/changed', 'hh:' || OLD.h, ${ms}); END`);
  await close(p5);
  const r5 = await K.main(path.join(dir, "no-such-dir", "missing.db"), path.join(dir, "copy5.db"), sqlite3);
  assert.equal(r5.mode, "cleared");
  const d5 = db(path.join(dir, "copy5.db"));
  try { assert.deepEqual(await all(d5, "SELECT * FROM hub_outbox"), []); } finally { await close(d5); }
});

// CL2: the pad chat archive (chatlog.js) - the same statements chatlog.js makes (its table, the external-content FTS index and
// the insert / delete triggers)
const ARCHIVE = [
  `CREATE TABLE chat_log (c INTEGER PRIMARY KEY, rk INTEGER NOT NULL, ts INTEGER NOT NULL, k TEXT NOT NULL, who TEXT, text TEXT,
    rt TEXT NOT NULL, aud TEXT NOT NULL, d TEXT NOT NULL, mid TEXT, tx TEXT, eid TEXT, rm_at INTEGER, rm_by TEXT, rm_why TEXT, purged INTEGER)`,
  "CREATE VIRTUAL TABLE chat_log_fts USING fts5(text, rt, content = 'chat_log', content_rowid = 'c', tokenize = 'unicode61 remove_diacritics 2')",
  `CREATE TRIGGER chat_log_ai AFTER INSERT ON chat_log WHEN new.text IS NOT NULL AND new.k IN ('msg','tx','topic') AND new.rm_at IS NULL AND new.purged IS NULL BEGIN
    INSERT INTO chat_log_fts (rowid, text, rt) VALUES (new.c, new.text, new.rt); END`,
  `CREATE TRIGGER chat_log_ad AFTER DELETE ON chat_log WHEN old.text IS NOT NULL AND old.k IN ('msg','tx','topic') AND old.rm_at IS NULL AND old.purged IS NULL BEGIN
    INSERT INTO chat_log_fts (chat_log_fts, rowid, text, rt) VALUES ('delete', old.c, old.text, old.rt); END`,
  "CREATE TABLE chatlog_meta (key TEXT PRIMARY KEY, value TEXT)",
  "CREATE TABLE chatlog_hidden (h TEXT PRIMARY KEY, since INTEGER NOT NULL, src TEXT NOT NULL)",
];
const words = (d, w) => all(d, "SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH ? ORDER BY rowid", ['"' + w + '"']).then((r) => r.map((x) => x.rowid));

test("CL2: staging keeps its own chat archive (rows, index, switches, hidden set) - prod's chat never lands on staging", async () => {
  const prod = path.join(dir, "copy6.db"), stg = path.join(dir, "staging6.db");
  await makeProd(prod); await makeStaging(stg);
  const p = db(prod);
  for (const s of ARCHIVE) await run(p, s);
  for (let c = 1; c <= 3; c++) await run(p, "INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (?, 1, ?, 'msg', 'produser', ?, 'r1', 'm', '{}')", [c, c, "prodsecret line " + c]);
  await run(p, "INSERT INTO chatlog_meta (key, value) VALUES ('cfg', '{\"notice\":true,\"archive\":true}')");
  await run(p, "INSERT INTO chatlog_hidden (h, since, src) VALUES ('aaaaaaaaaaaaaaaaaaaa', 1, 'pepe')");
  await close(p);
  const s = db(stg);
  for (const x of ARCHIVE) await run(s, x);
  await run(s, "INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (50, 1, 50, 'msg', 'stguser', 'staging words here', 'r1', 'm', '{}')");
  await run(s, "INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d, rm_at) VALUES (51, 1, 51, 'msg', 'stguser', 'removed staging line', 'r1', 'm', '{}', 5)");
  await run(s, "INSERT INTO chatlog_meta (key, value) VALUES ('cfg', '{\"notice\":false}')");
  await close(s);
  const r = await K.main(stg, prod, sqlite3);
  assert.equal(r.mode, "kept");
  assert.ok(r.tables.some((t) => t.table === "chat_log_fts" && t.reindexed === 1), JSON.stringify(r.tables));
  const d = db(prod);
  try {
    assert.deepEqual((await all(d, "SELECT c, who FROM chat_log ORDER BY c")).map((x) => [x.c, x.who]), [[50, "stguser"], [51, "stguser"]]);
    assert.deepEqual(await words(d, "prodsecret"), [], "prod's words aren't in staging's index");
    assert.deepEqual(await words(d, "staging"), [50], "staging's indexable rows are (the removed one isn't)");
    assert.deepEqual(await all(d, "SELECT value FROM chatlog_meta"), [{ value: '{"notice":false}' }], "staging's own switches");
    assert.deepEqual(await all(d, "SELECT * FROM chatlog_hidden"), [], "staging's own hidden set");
    assert.deepEqual(await all(d, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'chat_log_%'"), [], "the site re-makes the triggers at start");
  } finally { await close(d); }
  // the fallback: prod's archive is cleared (no per-row index work), the index emptied
  const p7 = path.join(dir, "copy7.db");
  await makeProd(p7);
  const d7 = db(p7);
  for (const x of ARCHIVE) await run(d7, x);
  await run(d7, "INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (1, 1, 1, 'msg', 'produser', 'prodsecret', 'r1', 'm', '{}')");
  await close(d7);
  const r7 = await K.main(path.join(dir, "no-such-dir", "missing.db"), p7, sqlite3);
  assert.equal(r7.mode, "cleared");
  const e7 = db(p7);
  try {
    assert.deepEqual(await all(e7, "SELECT * FROM chat_log"), []);
    assert.deepEqual(await words(e7, "prodsecret"), []);
  } finally { await close(e7); }
});

test("Train 3 review: staging's archive in its own CHATLOG_DB - prod's chat_log / chat_log_fts are dropped from the copy, not left empty (no split at staging's next start)", async () => {
  const prod = path.join(dir, "copy10.db"), stg = path.join(dir, "staging10.db");
  await makeProd(prod); await makeStaging(stg);
  const p = db(prod);
  for (const s of ARCHIVE) await run(p, s);
  await run(p, "CREATE INDEX chat_log_room ON chat_log (rk, c)");
  for (let c = 1; c <= 5; c++) await run(p, "INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (?, 1, ?, 'msg', 'produser', ?, 'r1', 'm', '{}')", [c, c, "prodsplitsecret " + c]);
  await close(p);
  // staging: the archive's small tables in myapp.db (counters, switches), chat_log itself in chatlog.db (not this file)
  const s = db(stg);
  for (const x of ARCHIVE.filter((x) => /chatlog_meta|chatlog_hidden/.test(x))) await run(s, x);
  await run(s, "CREATE TABLE chatlog_rooms (rk INTEGER PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, \"rows\" INTEGER NOT NULL DEFAULT 0)");
  await run(s, "INSERT INTO chatlog_rooms (rk, room_id, created, \"rows\") VALUES (1, 'PepeLab.Room', 1, 7)");
  await run(s, "INSERT INTO chatlog_meta (key, value) VALUES ('cfg', '{\"notice\":true,\"archive\":true,\"started_at\":5}')");
  await close(s);
  const r = await K.main(stg, prod, sqlite3);
  assert.equal(r.mode, "kept");
  assert.ok(r.tables.some((t) => t.table === "chat_log" && t.dropped), JSON.stringify(r.tables));
  assert.ok(r.tables.some((t) => t.table === "chat_log_fts" && t.dropped), JSON.stringify(r.tables));
  const d = db(prod);
  try {
    assert.deepEqual(await all(d, "SELECT name FROM sqlite_master WHERE name GLOB 'chat_log*'"), [], "no chat_log, index, FTS (or its shadow tables) in the copy");
    assert.deepEqual(await all(d, "SELECT room_id, \"rows\" AS n FROM chatlog_rooms"), [{ room_id: "PepeLab.Room", n: 7 }], "staging's own counters kept");
  } finally { await close(d); }
  const bytes = fs.readFileSync(prod).toString("latin1");
  assert.ok(!bytes.includes("prodsplitsecret"), "prod's words are gone from the file");
});

// CL2 fix-up: prod's live feed (bridge_feed / bridge_rooms: the last 200 items of every prod room) never lands on staging either -
// staging's first archive switch-on would seed it into staging's archive - and nothing of prod's chat stays behind in the copy's
// free pages (secure_delete: deleted rows are overwritten)
const FEED = [
  "CREATE TABLE bridge_rooms (id TEXT PRIMARY KEY, slug TEXT, name TEXT, snap TEXT, updated INTEGER)",
  "CREATE TABLE bridge_feed (c INTEGER PRIMARY KEY, room_id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL)",
];
test("CL2 fix-up: staging keeps its own live feed (bridge_feed, bridge_rooms), and prod's chat leaves no bytes in the copy", async () => {
  const prod = path.join(dir, "copy8.db"), stg = path.join(dir, "staging8.db");
  await makeProd(prod); await makeStaging(stg);
  const p = db(prod);
  for (const s of [...ARCHIVE, ...FEED]) await run(p, s);
  const big = "prodfeedsecret ".repeat(400);                                   // spills onto overflow pages too
  await run(p, "INSERT INTO bridge_rooms (id, slug, name, snap, updated) VALUES ('Prod.Room', 'prod-room', 'Prod Room', '{}', 1)");
  for (let c = 1; c <= 50; c++) await run(p, "INSERT INTO bridge_feed (c, room_id, ts, data) VALUES (?, 'Prod.Room', ?, ?)", [c, c, JSON.stringify({ k: "msg", text: "prodfeedsecret " + c })]);
  await run(p, "INSERT INTO bridge_feed (c, room_id, ts, data) VALUES (51, 'Prod.Room', 51, ?)", [JSON.stringify({ k: "msg", text: big })]);
  for (let c = 1; c <= 20; c++) await run(p, "INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (?, 1, ?, 'msg', 'produser', ?, 'r1', 'm', '{}')", [c, c, "prodarchivesecret " + c]);
  await close(p);
  const s = db(stg);
  for (const x of [...ARCHIVE, ...FEED]) await run(s, x);
  await run(s, "INSERT INTO bridge_rooms (id, slug, name, snap, updated) VALUES ('PepeLab.Room', 'pepelab', 'PepeLab', '{}', 2)");
  await run(s, "INSERT INTO bridge_feed (c, room_id, ts, data) VALUES (900, 'PepeLab.Room', 900, ?)", [JSON.stringify({ k: "msg", text: "staging line" })]);
  await close(s);
  const r = await K.main(stg, prod, sqlite3);
  assert.equal(r.mode, "kept");
  const d = db(prod);
  try {
    assert.deepEqual(await all(d, "SELECT id FROM bridge_rooms"), [{ id: "PepeLab.Room" }], "staging's own rooms");
    assert.deepEqual((await all(d, "SELECT c, room_id FROM bridge_feed")).map((x) => [x.c, x.room_id]), [[900, "PepeLab.Room"]], "staging's own live tail");
    assert.deepEqual(await all(d, "SELECT COUNT(*) AS n FROM chat_log"), [{ n: 0 }]);
  } finally { await close(d); }
  const bytes = fs.readFileSync(prod).toString("latin1");
  for (const w of ["prodfeedsecret", "prodarchivesecret"]) assert.ok(!bytes.includes(w), w + " is gone from the file, free pages included");
  // the fallback (staging's DB unreadable) clears them the same way
  const p9 = path.join(dir, "copy9.db");
  await makeProd(p9);
  const d9 = db(p9);
  for (const x of [...ARCHIVE, ...FEED]) await run(d9, x);
  await run(d9, "INSERT INTO bridge_feed (c, room_id, ts, data) VALUES (1, 'Prod.Room', 1, ?)", [JSON.stringify({ k: "msg", text: "prodfeedsecret" })]);
  await run(d9, "INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (1, 1, 1, 'msg', 'produser', 'prodarchivesecret', 'r1', 'm', '{}')");
  await close(d9);
  assert.equal((await K.main(path.join(dir, "no-such-dir", "missing.db"), p9, sqlite3)).mode, "cleared");
  const b9 = fs.readFileSync(p9).toString("latin1");
  for (const w of ["prodfeedsecret", "prodarchivesecret"]) assert.ok(!b9.includes(w), w + " is gone (fallback)");
});
