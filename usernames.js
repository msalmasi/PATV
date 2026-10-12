// usernames.js — 1.99tc: PATV username history + the one resolver for usernames that arrive from Pepe.
//
// Why: Pepe keeps money records (escrow holds, loans, wagers, gang treasuries, lotto tickets...) that name a PATV
// account by its USERNAME. A username is not stable: !patv set / Edit profile rename it, and a merge folds one
// account into another (the old account's name disappears). On 2026-10-12 the prod escrow cutover was refused with
// "no PATV account for Hfddhh": hold h3919 named Hfddhh, which had been renamed to WutUpWattz after a Camfrog-link
// merge. The site kept no record of either step, so nothing could resolve the stale name.
//
//   username_history  userId, old_username, new_username, at, via, note
//     one row per rename (via 'rename:web', 'rename:pepe', ...) and per merge (the merged-away account's name,
//     via 'merge'), plus 'seen' rows from the backfill (a name an account is known to have had).
//
// resolve(name) - the account a username stands for:
//   1. the account called that now (exact, then case-insensitive when unique);
//   2. otherwise the history + account_merge_log, every match followed through merges to the live account. Exactly one
//      live account -> that account (via "history"); several -> refused as ambiguous (E_AMBIGUOUS), never a guess.
//   {strict:true} (the cutover imports) also refuses a CURRENT name that another live account used to have, unless the
//   record's time (`at`, ms) is after that account gave it up.
// resolveUserId(id) - a userId followed through merges (ledger.account_merges, then account_merge_log).
// Renames into a name another account used to have are refused (reservedFor), so history never becomes ambiguous by
// a new rename.
//
// The same table keeps CAMFROG LOGIN history (kind 'camfrog'): Pepe keys gangs / stashes / loans / GTF by Camfrog login, and
// a !verify of a different Camfrog name REPLACES the account's login (Hfddhh's watermelonfelon became wutupwattz on
// 2026-10-12) - the old login then resolves to nobody. resolveLogin() is resolve() for logins; resolveRecord() uses it.
//
// The same table keeps CAMFROG LOGIN history (kind 'camfrog'): Pepe keys gangs / stashes / loans / GTF by Camfrog login, and
// a !verify of a different Camfrog name REPLACES the account's login (Hfddhh's watermelonfelon became wutupwattz on
// 2026-10-12) - the old login then resolves to nobody. resolveLogin() is resolve() for logins; resolveRecord() uses it.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const E_AMBIGUOUS = "E_AMBIGUOUS";
const E_NOT_FOUND = "E_TARGET_NOT_FOUND";
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

let readyP = null;
function ensure() {
  if (readyP) return readyP;
  readyP = (async () => {
    // kind: 'username' (a PATV username) | 'camfrog' (a Camfrog login the account was linked to)
    await runQuery(`CREATE TABLE IF NOT EXISTS username_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, old_username TEXT NOT NULL, new_username TEXT,
      at INTEGER NOT NULL, via TEXT NOT NULL, note TEXT, kind TEXT NOT NULL DEFAULT 'username')`);
    await runQuery("CREATE INDEX IF NOT EXISTS username_history_old ON username_history (kind, lower(old_username))");
    await runQuery("CREATE INDEX IF NOT EXISTS username_history_user ON username_history (userId, at)");
    // the backfill (and a retried rename) never writes the same fact twice
    await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS username_history_once ON username_history (kind, userId, lower(old_username), via, at)");
    await runQuery("CREATE TABLE IF NOT EXISTS username_history_meta (k TEXT PRIMARY KEY, v TEXT)");
    return true;
  })().catch((e) => { readyP = null; throw e; });
  return readyP;
}

async function hasTable(name) {
  return (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name])).length > 0;
}

/**
 * Remember that `userId` was called `oldName` (and is now `newName`). Call it right after the UPDATE / merge, in the
 * same transaction when there is one. A case-only change or an empty name writes nothing. -> true when written
 */
async function record(userId, oldName, newName, via, { at = null, note = null, kind = "username" } = {}) {
  const o = String(oldName == null ? "" : oldName).trim();
  if (!userId || !o) return false;
  if (newName != null && low(newName) === low(o) && via !== "seen") return false;
  await ensure();
  const ins = () => runQuery(`INSERT OR IGNORE INTO username_history (userId, old_username, new_username, at, via, note, kind)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`,
                           [String(userId), o.slice(0, 80), newName == null ? null : String(newName).slice(0, 80),
                            Math.trunc(Number(at) || Date.now()), String(via || "rename").slice(0, 40), note ? String(note).slice(0, 200) : null,
                            kind === "camfrog" ? "camfrog" : "username"]);
  let r;
  try { r = await ins(); } catch (e) {
    if (!/no such table/i.test(e.message)) throw e;
    readyP = null;                                     // the table was made inside a transaction that rolled back
    await ensure();
    r = await ins();
  }
  return !!(r && r.changes);
}

/** The live account an id stands for: itself, else followed through merges (account_merges, then account_merge_log). */
async function resolveUserId(id) {
  if (!id) return null;
  let cur = String(id);
  for (let hop = 0; hop < 8; hop++) {
    if ((await getQuery("SELECT 1 FROM users WHERE userId = ?", [cur])).length) return cur;
    let next = null;
    if (await hasTable("account_merges")) {
      const m = (await getQuery("SELECT new_id FROM account_merges WHERE old_id = ?", [cur]))[0];
      if (m && m.new_id) next = m.new_id;
    }
    if (!next && (await hasTable("account_merge_log"))) {
      const m = (await getQuery("SELECT to_id FROM account_merge_log WHERE from_id = ? ORDER BY at DESC LIMIT 1", [cur]))[0];
      if (m && m.to_id) next = m.to_id;
    }
    if (!next || next === cur) return null;
    cur = next;
  }
  return null;
}

/** A Camfrog login `userId` was linked to and isn't any more (a relink to another login, an unlink, another account's
 *  !verify of it). Same rules as record(). */
const recordLogin = (userId, oldLogin, newLogin, via, opts = {}) =>
  record(userId, low(oldLogin), newLogin == null ? null : low(newLogin), via, Object.assign({}, opts, { kind: "camfrog" }));

/** Every account that ever had `name` (history + merge log + merge archive), as [{userId, at, via, gaveUp}] - raw ids. */
async function pastHolders(name, kind = "username") {
  const l = low(name);
  if (!l) return [];
  await ensure();
  const out = [];
  for (const r of await getQuery(`SELECT userId, at, via, new_username FROM username_history WHERE kind = ? AND lower(old_username) = ?`, [kind, l])) {
    out.push({ userId: r.userId, at: Number(r.at) || 0, via: r.via, gaveUp: r.via !== "seen" });
  }
  if (kind === "username" && (await hasTable("account_merge_log"))) {
    for (const r of await getQuery(`SELECT from_id, to_id, at FROM account_merge_log WHERE lower(from_username) = ?`, [l])) {
      out.push({ userId: r.to_id, at: Number(r.at) || 0, via: "merge", gaveUp: true, from: r.from_id });
    }
    for (const r of await getQuery(`SELECT to_id, at FROM account_merge_log WHERE lower(to_username) = ?`, [l])) {
      out.push({ userId: r.to_id, at: Number(r.at) || 0, via: "seen", gaveUp: false });
    }
  }
  return out;
}

const COLS = "userId, username, camfrogUsername";

/**
 * The account `name` stands for. opts: cols (SQL column list, default userId, username, camfrogUsername),
 * strict (refuse a current name another account used to have, see the header), at (the record's time, ms).
 * -> {ok:true, user, via: "current" | "case" | "history", from?} | {ok:false, code, error, candidates?}
 */
const resolve = (name, opts = {}) => resolveBy("username", name, opts);
/** resolve() for a Camfrog login: the account linked to it now, else the one it used to be linked to (when only one). */
const resolveLogin = (login, opts = {}) => resolveBy("camfrog", String(login == null ? "" : login).trim().replace(/^@+/, ""), opts);

async function resolveBy(kind, name, opts = {}) {
  const n = String(name == null ? "" : name).trim();
  const cols = opts.cols || COLS;
  const what = kind === "camfrog" ? "Camfrog login" : "PATV username";
  if (!n) return { ok: false, code: E_NOT_FOUND, error: `no ${what}` };
  let cur, via = "current";
  if (kind === "camfrog") {
    cur = await getQuery(`SELECT ${cols}, userId AS __id FROM users WHERE lower(trim(camfrogUsername)) = lower(?)`, [n]);
    if (cur.length > 1) return { ok: false, code: E_AMBIGUOUS, error: `the Camfrog login ${n} is linked to ${cur.length} accounts - send the userId`, candidates: cur.map((u) => u.username) };
  } else {
    cur = await getQuery(`SELECT ${cols}, userId AS __id FROM users WHERE username = ?`, [n]);
    if (!cur.length) {
      cur = await getQuery(`SELECT ${cols}, userId AS __id FROM users WHERE LOWER(username) = LOWER(?)`, [n]);
      via = "case";
      if (cur.length > 1) return { ok: false, code: E_AMBIGUOUS, error: `the PATV username ${n} matches ${cur.length} accounts (letter case) - send the userId`, candidates: cur.map((u) => u.username) };
    }
  }
  const past = await pastHolders(n, kind);
  if (cur.length === 1) {
    const me = cur[0].__id;
    if (opts.strict) {
      const others = [];
      for (const p of past) {
        const live = await resolveUserId(p.userId);
        if (!live || live === me) continue;
        // a rename / merge row's time is when the other account gave the name up: a record made after it is ours
        if (p.gaveUp && opts.at && Number(opts.at) > p.at) continue;
        others.push(live);
      }
      if (others.length) {
        const names = await namesOf([me].concat(others));
        return { ok: false, code: E_AMBIGUOUS, error: `the ${what} ${n} belongs to ${names[me] || me} now but was ${[...new Set(others)].map((o) => names[o] || o).join(", ")}'s before - send the userId`,
                 candidates: [me].concat([...new Set(others)]) };
      }
    }
    return { ok: true, user: strip(cur[0]), via };
  }
  // not anybody's name now: who had it?
  const live = new Map();
  for (const p of past) {
    const id = await resolveUserId(p.userId);
    if (id && !live.has(id)) live.set(id, p);
  }
  if (!live.size) return { ok: false, code: E_NOT_FOUND, error: `no PATV account for ${n}` };
  if (live.size > 1) {
    const ids = [...live.keys()];
    const names = await namesOf(ids);
    return { ok: false, code: E_AMBIGUOUS, error: `the old ${what} ${n} was used by ${ids.length} accounts (${ids.map((i) => names[i] || i).join(", ")}) - can't tell which; send the userId`,
             candidates: ids };
  }
  const [id] = live.keys();
  const row = (await getQuery(`SELECT ${cols}, userId AS __id FROM users WHERE userId = ?`, [id]))[0];
  if (!row) return { ok: false, code: E_NOT_FOUND, error: `no PATV account for ${n}` };
  return { ok: true, user: strip(row), via: "history", from: n };
}
function strip(r) { const o = Object.assign({}, r); delete o.__id; return o; }
async function namesOf(ids) {
  const out = {};
  for (const id of new Set(ids)) {
    const r = (await getQuery("SELECT username FROM users WHERE userId = ?", [id]))[0];
    if (r) out[id] = r.username;
  }
  return out;
}

/** resolve() for callers that only want the row: the account, or null (an ambiguous name is null, and logged). */
async function findUser(name, opts = {}) {
  const r = await resolve(name, opts);
  if (r.ok) {
    if (r.via === "history") console.log(`[usernames] old name ${r.from} -> ${r.user.username} (${r.user.userId})`);
    return r.user;
  }
  if (r.code === E_AMBIGUOUS) console.error(`[usernames] ${r.error}`);
  return null;
}

/**
 * The account for a Pepe record: its userId when it still resolves (followed through merges), else its username via
 * resolve(). -> same shape as resolve(), plus via "userId".
 */
async function resolveRecord({ userId, username, login } = {}, opts = {}) {
  const cols = opts.cols || COLS;
  if (userId) {
    const id = await resolveUserId(userId);
    if (id) {
      const row = (await getQuery(`SELECT ${cols} FROM users WHERE userId = ?`, [id]))[0];
      if (row) return { ok: true, user: row, via: id === String(userId) ? "userId" : "merged" };
    }
  }
  if (username) {
    const r = await resolve(username, opts);
    if (r.ok || r.code === E_AMBIGUOUS) return r;
  }
  if (login) {
    // 1.99tc: an old Camfrog login (the account relinked to another one) resolves through the login history
    const r = await resolveLogin(login, opts);
    if (r.ok) return Object.assign(r, { via: r.via === "history" ? "login-history" : "login" });
    if (r.code === E_AMBIGUOUS) return r;
  }
  return { ok: false, code: E_NOT_FOUND, error: `no PATV account for ${username || userId || login || "?"}` };
}

/** findUser() for a Camfrog login. */
async function findLogin(login, opts = {}) {
  const r = await resolveLogin(login, opts);
  if (r.ok) return r.user;
  if (r.code === E_AMBIGUOUS) console.error(`[usernames] ${r.error}`);
  return null;
}

/** findUser() for a Camfrog login. */
async function findLogin(login, opts = {}) {
  const r = await resolveLogin(login, opts);
  if (r.ok) return r.user;
  if (r.code === E_AMBIGUOUS) console.error(`[usernames] ${r.error}`);
  return null;
}

/** Before a rename to `name`: the live account (not `userId`) that used to be called that, or null. */
async function reservedFor(name, userId) {
  for (const p of await pastHolders(name)) {
    const id = await resolveUserId(p.userId);
    if (id && id !== String(userId)) return id;
  }
  return null;
}

// ── the one-time backfill ─────────────────────────────────────────────────────────────────────────────────
// Sources: account_merge_log (merged-away names; names the target had at merge time), account_archive MERGE snapshots,
// admin_audit target names, escrow holds' recorded usernames, account_merges (old ids whose names were archived), plus
// run logs of hand merges ("[DUP-MERGE] old -> new: ..." lines, the --merge-log option of tools/username-history.js).
// Only names that differ from the account's name today are written. INSERT OR IGNORE: running it again adds nothing.
const tsOf = (v) => { const n = Number(v); if (Number.isFinite(n) && n > 1e11) return Math.trunc(n); const d = Date.parse(String(v || "")); return Number.isFinite(d) ? d : 0; };

async function backfill({ apply = false, mergeLogLines = [] } = {}) {
  await ensure();
  const facts = [];                      // {userId, old, at, via, note}
  const add = (userId, old, at, via, note) => { if (userId && old) facts.push({ userId: String(userId), old: String(old), at: tsOf(at) || 1, via, note }); };
  if (await hasTable("account_merge_log")) {
    for (const r of await getQuery("SELECT id, at, via, from_id, to_id, from_username, to_username FROM account_merge_log")) {
      add(r.to_id, r.from_username, r.at, "merge", `account_merge_log #${r.id} (${r.via})`);
      add(r.to_id, r.to_username, r.at, "seen", `merge target name, account_merge_log #${r.id}`);
    }
  }
  if (await hasTable("account_archive")) {
    for (const r of await getQuery("SELECT userId, archived_at, snapshot FROM account_archive WHERE tier = 'MERGE'")) {
      let s = {};
      try { s = JSON.parse(r.snapshot || "{}"); } catch (e) { continue; }
      if (s.merged_into && s.username) add(s.merged_into, s.username, r.archived_at, "merge", "account_archive (merge snapshot)");
    }
  }
  if (await hasTable("admin_audit")) {
    for (const r of await getQuery("SELECT target_id, target_name, MIN(at) AS at FROM admin_audit WHERE target_id IS NOT NULL AND target_name IS NOT NULL GROUP BY target_id, target_name")) {
      add(r.target_id, r.target_name, r.at, "seen", "admin_audit");
    }
  }
  if (await hasTable("escrow_holds")) {
    for (const r of await getQuery("SELECT user_id, username, MIN(created) AS at FROM escrow_holds WHERE user_id IS NOT NULL AND username IS NOT NULL GROUP BY user_id, username")) {
      add(r.user_id, r.username, r.at, "seen", "escrow_holds");
    }
  }
  // Camfrog logins an account was seen with (escrow holds, the casino rep queue) that it isn't linked to any more
  const logins = [];
  const addL = (userId, login, at, note) => { if (userId && login) logins.push({ userId: String(userId), old: low(login), at: tsOf(at) || 1, note }); };
  if (await hasTable("escrow_holds")) {
    for (const r of await getQuery("SELECT user_id, login, MIN(created) AS at FROM escrow_holds WHERE user_id IS NOT NULL AND login IS NOT NULL GROUP BY user_id, lower(login)")) {
      addL(r.user_id, r.login, r.at, "escrow_holds");
    }
  }
  if (await hasTable("casino_rep_queue")) {
    for (const r of await getQuery("SELECT userId, camfrog, MIN(created) AS at FROM casino_rep_queue WHERE userId IS NOT NULL AND camfrog IS NOT NULL GROUP BY userId, lower(camfrog)")) {
      addL(r.userId, r.camfrog, r.at, "casino_rep_queue");
    }
  }
  // hand-merge run logs: "[DUP-MERGE] CFxxxx -> Delisha: ..." (old name -> the name of the account it went into)
  const unresolvedLog = [];
  for (const line of mergeLogLines || []) {
    const m = /^\[[A-Z-]*MERGE\]\s+(\S+)\s+->\s+([^:\s]+):/.exec(String(line).trim());
    if (!m) continue;
    const r = await resolve(m[2]);
    if (!r.ok) { unresolvedLog.push(`${m[1]} -> ${m[2]}: ${r.error}`); continue; }
    add(r.user.userId, m[1], 1, "merge", `merge run log (${m[1]} -> ${m[2]})`);
  }
  // keep only names that differ from the account's name today, on accounts that resolve
  const rows = [];
  const skipped = [];
  for (const f of facts) {
    const id = await resolveUserId(f.userId);
    if (!id) { skipped.push(`${f.old} (${f.userId}: no live account)`); continue; }
    const now = (await getQuery("SELECT username FROM users WHERE userId = ?", [id]))[0];
    if (now && low(now.username) === low(f.old)) continue;
    rows.push(Object.assign({}, f, { userId: id, now: now ? now.username : null }));
  }
  for (const f of logins) {
    const id = await resolveUserId(f.userId);
    if (!id) { skipped.push(`login ${f.old} (${f.userId}: no live account)`); continue; }
    const now = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [id]))[0];
    if (now && low(now.camfrogUsername) === f.old) continue;
    // a login some OTHER account is linked to now is that account's; this is only a trace
    rows.push({ userId: id, old: f.old, now: now ? now.camfrogUsername || null : null, via: "seen", note: f.note, at: f.at, kind: "camfrog" });
  }
  let written = 0;
  if (apply) {
    for (const r of rows) if (await record(r.userId, r.old, r.now, r.via, { at: r.at, note: r.note, kind: r.kind || "username" })) written++;
    await runQuery("INSERT INTO username_history_meta (k, v) VALUES ('backfill', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                   [JSON.stringify({ at: Date.now(), rows: rows.length, written })]);
  }
  return { ok: true, apply, found: rows.length, written, rows: rows.map((r) => ({ kind: r.kind || "username", userId: r.userId, old: r.old, now: r.now, via: r.via, note: r.note })),
           skipped, unresolvedLog };
}

/** On boot: the backfill once per database (the meta row says it ran). Never throws. */
async function backfillOnce() {
  try {
    await ensure();
    const done = (await getQuery("SELECT v FROM username_history_meta WHERE k = 'backfill'"))[0];
    if (done) return null;
    const r = await backfill({ apply: true });
    console.log(`[usernames] history backfilled: ${r.written} name(s) from ${r.found} trace(s)`);
    return r;
  } catch (e) {
    console.error("[usernames] backfill:", e.message);
    return null;
  }
}

/**
 * POST /api/users/resolve (bot token): {names: [...], ids: [...], logins: [...]} -> {ok, names: {name: {ok, userId, username, via} |
 * {ok:false, code, error}}, ids: {id: {ok, userId, username, via}}, logins: {login: same as names}}. Pepe uses it to put userIds on the records he kept by name, and the
 * stale-name scan uses it. Read-only. At most 500 of each per call.
 */
function register(app, { isBotToken }) {
  ensure().catch((e) => console.error("[usernames] setup:", e.message));
  app.post("/api/users/resolve", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const names = {}, ids = {}, logins = {};
      for (const n of (Array.isArray(b.names) ? b.names : []).slice(0, 500)) {
        const k = String(n || "").slice(0, 80);
        if (!k || names[k]) continue;
        const r = await resolve(k, { strict: !!b.strict });
        names[k] = r.ok ? { ok: true, userId: r.user.userId, username: r.user.username, via: r.via } : { ok: false, code: r.code, error: r.error };
      }
      for (const i of (Array.isArray(b.ids) ? b.ids : []).slice(0, 500)) {
        const k = String(i || "").slice(0, 64);
        if (!k || ids[k]) continue;
        const id = await resolveUserId(k);
        const row = id ? (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [id]))[0] : null;
        ids[k] = row ? { ok: true, userId: row.userId, username: row.username, via: id === k ? "userId" : "merged" } : { ok: false, code: E_NOT_FOUND };
      }
      for (const n of (Array.isArray(b.logins) ? b.logins : []).slice(0, 500)) {
        const k = String(n || "").slice(0, 80);
        if (!k || logins[k]) continue;
        const r = await resolveLogin(k, { strict: !!b.strict });
        logins[k] = r.ok ? { ok: true, userId: r.user.userId, username: r.user.username, login: r.user.camfrogUsername || null, via: r.via }
                         : { ok: false, code: r.code, error: r.error };
      }
      res.json({ ok: true, names, ids, logins });
    } catch (e) {
      console.error("[usernames] resolve:", e.message);
      res.status(500).json({ ok: false, error: "internal server error" });
    }
  });
}

module.exports = { register, ensure, record, recordLogin, resolve, resolveLogin, resolveRecord, resolveUserId, findUser, findLogin, reservedFor,
                   pastHolders, backfill, backfillOnce,
                   E_AMBIGUOUS, E_NOT_FOUND };
