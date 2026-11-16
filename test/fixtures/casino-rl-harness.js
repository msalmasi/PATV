"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const assert = require("node:assert/strict");
const repo = path.resolve(__dirname, "../..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "casino-rl-")));
delete process.env.STAGING;
const { runQuery: sql, getQuery: rows } = require(path.join(repo, "dbUtils"));
const svc = require(path.join(repo, "casino/service"));
const fair = require(path.join(repo, "casino/fair"));
const funding = require(path.join(repo, "funding"));
const veil = require(path.join(repo, "casino/veil"));
const held = require(path.join(repo, "supply")).casinoHeld;
let now = Date.UTC(2026, 10, 1),
  seq = 0;
const time = () => now;
svc.S.hooks.now = time;
const actor = (uid, via = "web") => ({
  uid,
  name: "Player" + uid,
  username: "player" + uid,
  camfrog: "Frog" + uid,
  via,
  iph: null,
  admin: false,
  veil: null,
});
const act = (T, uid, verb, line, opts = {}) =>
  svc.act(
    actor(uid, opts.via || "web"),
    verb,
    line == null ? [] : [line],
    {
      table: T?.id,
      room: opts.room ?? T?.room ?? null,
      game: opts.game ?? (opts.via === "room" ? "roulette" : null),
    },
    opts.key || "rl-test-" + ++seq,
  );
const cash = async (uid) => (await rows("SELECT points_balance AS n FROM users WHERE userId=?", [uid]))[0].n;
const house = async () => (await rows("SELECT SUM(amount) AS n FROM jackpot_rakes"))[0].n;
const total = async () =>
  (await rows("SELECT SUM(points_balance) AS n FROM users"))[0].n + (await held()) + (await house());
const move = (ms) => {
  now += ms;
};
const tick = async (ms) => {
  move(ms);
  await svc.tickOnce();
};
const lobby = () => [...svc.S.tables.values()].find((t) => t.lobby && t.status === "open");
const expect = (out) => {
  assert.ok(out.ok, out.reply);
  return out;
};
async function room(id = "pad-a") {
  const out = expect(await act(null, "a", "start", null, { room: id, via: "room", game: "roulette" }));
  return svc.getTable(out.table);
}
async function initialize() {
  await sql(
    "CREATE TABLE users (userId TEXT PRIMARY KEY,username TEXT UNIQUE,displayname TEXT,password TEXT,class TEXT DEFAULT 'pleb',points_balance INTEGER DEFAULT 0,camfrogUsername TEXT,casino_banned INTEGER DEFAULT 0,level INTEGER DEFAULT 0,avatar TEXT)",
  );
  await sql(
    "CREATE TABLE transactions (transactionId TEXT PRIMARY KEY,userId TEXT NOT NULL,type TEXT NOT NULL,points INTEGER NOT NULL,timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)",
  );
  await sql(
    "CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY,spinId TEXT,userId TEXT,amount INTEGER NOT NULL,timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)",
  );
  await sql("CREATE TABLE user_roles (userId TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY (userId,role))");
  await sql("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY,dup_of TEXT)");
  for (const id of ["a", "b", "c", "d"])
    await sql(
      "INSERT INTO users (userId,username,displayname,camfrogUsername,class,points_balance) VALUES (?,?,?,?,?,500000)",
      [id, actor(id).username, actor(id).name, actor(id).camfrog, id === "a" ? "Staff" : "pleb"],
    );
  await sql(
    "CREATE TABLE badges (badgeId TEXT PRIMARY KEY, name TEXT,description TEXT,icon TEXT,points INTEGER,requirement TEXT,pat INTEGER DEFAULT 0)",
  );
  await funding.init();
  require(path.join(repo, "casino/rewards")).hooks.updateLevel = async () => {};
}
async function fresh() {
  svc.stop();
  svc.S.rate.clear();
  svc.S.hooks.crash = null;
  veil._reset();
  veil._hooks.kind = async () => null;
  for (const name of [
    "casino_tables",
    "casino_rl_lines",
    "casino_rl_queue",
    "casino_rounds",
    "casino_events",
    "casino_actions",
    "casino_settings",
    "casino_ach_counts",
    "casino_reward_done",
    "casino_notice_seen",
    "transactions",
    "reserve_claims",
    "jackpot_rakes",
    "welcome_bonus",
  ])
    await sql("DELETE FROM " + name).catch(() => {});
  await sql("UPDATE users SET points_balance=500000,casino_banned=0");
  await sql("INSERT INTO jackpot_rakes(jackpotId,spinId,amount) VALUES ('seed','seed',25000000)");
  funding.sync({});
  now += 86400000;
  await svc.boot({ tick: false });
  await svc.setSetting("casino_roulette", "everyone");
  await svc.tickOnce();
}
async function restart(id) {
  svc.stop();
  svc.S.hooks.crash = null;
  await svc.boot({ tick: false });
  return svc.getTable(id);
}
module.exports = {
  repo,
  svc,
  fair,
  funding,
  veil,
  held,
  sql,
  rows,
  time,
  actor,
  act,
  cash,
  house,
  total,
  move,
  tick,
  lobby,
  expect,
  room,
  initialize,
  fresh,
  restart,
};
