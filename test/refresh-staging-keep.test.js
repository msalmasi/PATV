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
  hub_hidden_h: "CREATE TABLE hub_hidden_h (h TEXT PRIMARY KEY, since INTEGER NOT NULL)",
};

async function makeProd(file, { withKeyTables = true } = {}) {
  const d = db(file);
  await run(d, "CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT)");
  await run(d, "INSERT INTO users VALUES ('u1', 'prod-user')");
  if (withKeyTables) {
    for (const t of ["bot_keys", "bot_keys_settings", "bot_key_families", "hubseam_settings", "legacy_token_daily", "events_auth_log", "hub_outbox", "hub_hidden_h"]) await run(d, SCHEMA[t]);
    await run(d, "INSERT INTO hub_hidden_h (h, since) VALUES ('0123456789abcdef0123', 1)");   // 1.99acm: prod's Pepe's hidden set
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
                                         "pad_hub"].sort(), "S1-D1: staging keeps its own hub pad ids");
  assert.deepEqual(K.EMPTY, ["hub_hidden_h", "hub_inbound_nonces", "hub_outbox"], "the outbox last (prod's triggers fire on the others)");
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
