// hubidentity.js — S1 Q5b (release L3): the identity/changed topic of the v1 seam (seam plan §12.2-§12.4, §12.6; ADR 0007
// D11): what the chat hub knows of an account - its status, the facts a hub rule reads and its chat-platform links.
// Entity acct:<userId>; switch hubseam.identity; huboutbox.js registers the topic, the reader and the snapshot.
//
//   {account, v1_user, status: active|archived|deleting|deleted|merged|gone, status_at: ms|null,
//    merged_into|null, v1_into|null, merged_from: [{account, v1_user}] (newest first, <= 50),
//    email_verified|null, level|null, created_at: ms|null,                  (all null: merged, deleted, gone)
//    links: [{platform: camfrog|discord|twitch|telegram, external_id, login|null, display|null}]}
//
// No site username or display name (data minimisation: no hub rule reads them; names reach the hub with the looks).
// status: a done deletion -> deleted (done_at; its users row is a pseudonym), an open one (scheduled / held) -> deleting
// (requested_at), users.archived_at -> archived; no users row: merged (account_merges.old_id, merged_at) or gone (a purge
// keeps no time). email_verified is verified.js's email proof. Links follow the platform rules (§12.4): Camfrog's
// external_id is lower(trim(login)) the way SQLite writes it (ASCII only, identity's own normalisation), 1-64 characters;
// Discord / Twitch / Telegram ids are 1-32 digits; one link per platform. A link that fails its rule is left out (v1 never
// posts what the hub must quarantine, bad_link) and counted (status().skipped).
//
// Triggers write (topic, entity) only, gated by the switch (S1-D3): users AFTER INSERT / DELETE / UPDATE OF the listed
// columns WHEN one changed (never a bare AFTER UPDATE: points and xp change on every chat line), telegram_links, account
// deletions (a request, its state), account_merges (an insert for both ids, and the upsert / chain re-point's UPDATE).
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const TOPIC = "identity/changed";
const SWITCH = "identity";
const MERGED_FROM_MAX = 50;
const USER_COLS = ["camfrogUsername", "discordId", "discordUsername", "twitchId", "twitchLogin", "twitchDisplayname", "archived_at",
                   "isEmailVerified", "email", "level"];
const ID_RE = /^[0-9]{1,32}$/;
const skipped = { camfrog: 0, discord: 0, twitch: 0, telegram: 0 };

const inList = (n) => Array(n).fill("?").join(",");
async function chunked(ids, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += 400) out.push(...(await fn(ids.slice(i, i + 400))));
  return out;
}
/** users.created_at (SQLite CURRENT_TIMESTAMP text, UTC; or a number) -> ms | null */
function createdMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) { const n = Number(v); return n > 1e11 ? n : n * 1000; }
  const t = Date.parse(String(v).trim().replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? "" : "Z"));
  return Number.isFinite(t) ? t : null;
}
const sqliteTrim = (s) => String(s == null ? "" : s).replace(/^ +| +$/g, "");
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const str = (v) => (v == null || v === "" ? null : String(v));

/** The links of a users row (+ its Telegram link), in the payload's order; a link that fails its platform's rule is left out. */
function linksOf(u, tg) {
  const out = [];
  const login = sqliteTrim(u.camfrogUsername);
  if (login) {
    const ext = asciiLower(login);
    if (Array.from(ext).length <= 64) out.push({ platform: "camfrog", external_id: ext, login, display: null });
    else skipped.camfrog++;
  }
  const d = str(u.discordId);
  if (d) {
    if (ID_RE.test(d)) out.push({ platform: "discord", external_id: d, login: str(u.discordUsername), display: null });
    else skipped.discord++;
  }
  const w = str(u.twitchId);
  if (w) {
    if (ID_RE.test(w)) out.push({ platform: "twitch", external_id: w, login: str(u.twitchLogin), display: str(u.twitchDisplayname) });
    else skipped.twitch++;
  }
  if (tg && str(tg.tg_id)) {
    const id = String(tg.tg_id);
    if (ID_RE.test(id)) out.push({ platform: "telegram", external_id: id, login: str(tg.handle), display: null });
    else skipped.telegram++;
  }
  return out;
}

const tables = { checked: false, has: new Set() };
async function hasTable(t) {
  if (!tables.checked || !tables.has.has(t)) {
    const r = await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('telegram_links','account_deletions','account_merges')");
    tables.has = new Set(r.map((x) => x.name));
    tables.checked = true;
  }
  return tables.has.has(t);
}

/** The identity payloads of these v1 user ids, read now. -> Map(userId -> payload) (every id present). */
async function build(userIds) {
  const ids = [...new Set([...(userIds || [])].filter((x) => x != null && x !== "").map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const HO = require("./huboutbox");
  const users = new Map((await chunked(ids, (part) => getQuery(
    `SELECT userId, ${USER_COLS.join(", ")}, created_at FROM users WHERE userId IN (${inList(part.length)})`, part))).map((r) => [String(r.userId), r]));
  const tg = new Map();
  if (await hasTable("telegram_links")) {
    for (const r of await chunked(ids, (part) => getQuery(`SELECT user_id, tg_id, handle FROM telegram_links WHERE user_id IN (${inList(part.length)})`, part))) {
      tg.set(String(r.user_id), r);
    }
  }
  const del = new Map();                                   // userId -> {done_at} | {requested_at}
  if (await hasTable("account_deletions")) {
    for (const r of await chunked(ids, (part) => getQuery(
      `SELECT user_id, state, requested_at, done_at, id FROM account_deletions WHERE user_id IN (${inList(part.length)}) AND state IN ('done','scheduled','held')
       ORDER BY id`, part))) {
      const cur = del.get(String(r.user_id));
      if (cur && cur.state === "done") continue;           // a done deletion wins over anything after it
      del.set(String(r.user_id), r);
    }
  }
  const mergedInto = new Map(), mergedFrom = new Map();
  if (await hasTable("account_merges")) {
    for (const r of await chunked(ids, (part) => getQuery(`SELECT old_id, new_id, merged_at FROM account_merges WHERE old_id IN (${inList(part.length)})`, part))) {
      mergedInto.set(String(r.old_id), r);
    }
    for (const r of await chunked(ids, (part) => getQuery(
      `SELECT old_id, new_id, merged_at FROM account_merges WHERE new_id IN (${inList(part.length)}) ORDER BY merged_at DESC, old_id`, part))) {
      const k = String(r.new_id);
      if (!mergedFrom.has(k)) mergedFrom.set(k, []);
      if (mergedFrom.get(k).length < MERGED_FROM_MAX) mergedFrom.get(k).push({ account: HO.accountOf(r.old_id), v1_user: String(r.old_id) });
    }
  }
  const emailProof = require("./verified").columnProofs;
  for (const id of ids) {
    const u = users.get(id);
    const p = { account: HO.accountOf(id), v1_user: id, status: "active", status_at: null, merged_into: null, v1_into: null,
                merged_from: mergedFrom.get(id) || [], email_verified: null, level: null, created_at: null, links: [] };
    if (!u) {
      const m = mergedInto.get(id);
      if (m) { p.status = "merged"; p.status_at = Number(m.merged_at) || null; p.merged_into = HO.accountOf(m.new_id); p.v1_into = String(m.new_id); }
      else p.status = "gone";
      out.set(id, p);
      continue;
    }
    const d = del.get(id);
    if (d && d.state === "done") {
      p.status = "deleted";
      p.status_at = Number(d.done_at) || null;
      out.set(id, p);
      continue;
    }
    if (d) { p.status = "deleting"; p.status_at = Number(d.requested_at) || null; }
    else if (u.archived_at != null && u.archived_at !== "") { p.status = "archived"; p.status_at = Number(u.archived_at) || null; }
    p.email_verified = emailProof({ isEmailVerified: u.isEmailVerified, email: u.email }).includes("email");
    p.level = u.level == null ? null : Number(u.level) || 0;
    p.created_at = createdMs(u.created_at);
    p.links = linksOf(u, tg.get(id));
    out.set(id, p);
  }
  return out;
}

// ── triggers (S1-D3): (topic, entity) only, gated by the switch ──
const MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const gate = () => `(SELECT value FROM hubseam_settings WHERE key = '${SWITCH}') = 'true'`;
const row = (expr) => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'acct:' || ${expr}, ${MS_SQL} WHERE ${expr} IS NOT NULL;`;
/** [name, sql] of every identity trigger. `userCols`: the users columns this database has (a test database may lack some;
 *  production has them all) - a trigger naming a missing column would fail every users write. */
function triggerSql(userCols = null) {
  const cols = USER_COLS.filter((c) => !userCols || userCols.has(c));
  const changed = cols.map((c) => `OLD."${c}" IS NOT NEW."${c}"`).join(" OR ");
  const T = [];
  const add = (name, on, body, when = "") => T.push([`hub_s1_id_${name}_v1`, `CREATE TRIGGER IF NOT EXISTS hub_s1_id_${name}_v1 ${on}
    WHEN ${gate()}${when ? " AND (" + when + ")" : ""} BEGIN ${body} END`]);
  add("users_i", "AFTER INSERT ON users", row("NEW.userId"));
  add("users_d", "AFTER DELETE ON users", row("OLD.userId"));
  if (cols.length) add("users_u", `AFTER UPDATE OF ${cols.map((c) => `"${c}"`).join(", ")} ON users`, row("NEW.userId"), changed);
  add("tg_i", "AFTER INSERT ON telegram_links", row("NEW.user_id"));
  add("tg_d", "AFTER DELETE ON telegram_links", row("OLD.user_id"));
  add("tg_u", "AFTER UPDATE ON telegram_links", row("NEW.user_id") + " " + row("(CASE WHEN OLD.user_id IS NOT NEW.user_id THEN OLD.user_id END)"));
  add("del_i", "AFTER INSERT ON account_deletions", row("NEW.user_id"));
  add("del_u", "AFTER UPDATE OF state ON account_deletions", row("NEW.user_id"), "OLD.state IS NOT NEW.state");
  add("merge_i", "AFTER INSERT ON account_merges", row("NEW.old_id") + " " + row("NEW.new_id"));
  add("merge_u", "AFTER UPDATE OF new_id, merged_at ON account_merges",
      row("NEW.old_id") + " " + row("NEW.new_id") + " " + row("(CASE WHEN OLD.new_id IS NOT NEW.new_id THEN OLD.new_id END)"),
      "OLD.new_id IS NOT NEW.new_id OR OLD.merged_at IS NOT NEW.merged_at");
  return T;
}

/** The source tables exist and carry the listed columns, then the triggers. Called by huboutbox.init(). */
async function init() {
  for (const [c, def] of [["archived_at", "INTEGER"], ["twitchLogin", "TEXT"]]) {     // staleaccounts.js / twitchlogin.js own them
    try { await runQuery(`ALTER TABLE users ADD COLUMN ${c} ${def}`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  await require("./telegram").init();
  await require("./accountdelete").init();
  await runQuery(`CREATE TABLE IF NOT EXISTS account_merges (
      old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, merged_at INTEGER NOT NULL, via TEXT)`);              // ledger.js's table
  await runQuery("CREATE INDEX IF NOT EXISTS account_merges_new ON account_merges (new_id)");
  await installTriggers(triggerSql(await usersColumns()));
  tables.checked = false;
}

const usersColumns = async () => new Set((await getQuery("SELECT name FROM pragma_table_info('users')")).map((r) => r.name));
/** Drop and create each trigger in ONE transaction (no write between them goes unseen): a definition this code changed
 *  replaces the old one at the next start. */
async function installTriggers(list) {
  await tx(async () => {
    for (const [name, sql] of list) {
      await runQuery(`DROP TRIGGER IF EXISTS ${name}`);
      await runQuery(sql);
    }
  });
}

// ── snapshot (§12.6): every account, every merged id, every deleted account - acct:<userId> in byte order ──
async function snapshotSource(bound, limit) {
  if (bound == null) return [];
  const ids = (await getQuery("SELECT userId AS id FROM users WHERE userId > ? ORDER BY userId LIMIT ?", [bound, limit])).map((r) => String(r.id));
  if (await hasTable("account_merges")) {
    for (const r of await getQuery(`SELECT old_id AS id FROM account_merges m WHERE old_id > ? AND NOT EXISTS (SELECT 1 FROM users u WHERE u.userId = m.old_id)
                                    ORDER BY old_id LIMIT ?`, [bound, limit])) ids.push(String(r.id));
  }
  const byte = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  const page = [...new Set(ids)].sort(byte).slice(0, limit);
  const built = await build(page);
  return page.map((id) => ({ entity: "acct:" + id, payload: built.get(id) }));
}

const status = () => ({ skipped: { ...skipped } });

module.exports = { TOPIC, SWITCH, init, build, linksOf, createdMs, triggerSql, installTriggers, usersColumns, snapshotSource, status, USER_COLS };
