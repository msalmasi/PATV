// stashes.js — 1.99ne: personal stashes ("🔐 personal vaults") live on the site; Pepe is a client.
//
// Until now a stash's balance, owner and members lived only in Pepe's pvaults.json: while he was down nobody could see
// or reach the PAT they had parked there, and the site only showed his last snapshot (wallet_snapshots "stashes").
// Now the site owns them - ONE source of truth, so nothing can be spent twice:
//
//   stashes        id (Pepe's ids carried over; new ones continue his sequence), owner (Camfrog login, lower case),
//                  name, balance, staked (the old fee-share stake lock - only unstaked PAT can leave), earned,
//                  created (s), closed (s), updated (ms)
//   stash_members  (stash_id, login)          who else may use it (Camfrog logins, lower case)
//   stash_moves    key PRIMARY KEY            every balance change, idempotent by key: a retry finds its key and
//                                             returns the first answer instead of moving twice
//   stash_meta     enabled / imported / seq / rev
//
// Every money move is ONE database transaction (mainstage's chain on the shared connection): the wallet row
// (ledger.post: a deposit only if the wallet covers it) + the stash balance (a withdrawal only if the stash's
// unstaked PAT covers it) + the move row. Same wallet transaction types as Pepe's escrow path ("stash-deposit",
// "stash-withdraw"), same limits (3 stashes per owner, 10 members, at least 100 PAT a move).
//
// The switch-over (the migration that runs on deploy): the site creates its tables at start (idempotent). While
// stashes are `enabled` here (default ON on staging, OFF on prod until an admin turns it on) and not imported yet,
// Pepe - at his next start or within a few minutes - freezes his stash commands, exports pvaults.json and posts it
// (POST /api/stash/bot/import). The import takes a verified SQLite backup first (sqlitecfg.backupTo = the online
// backup API, never a file copy), checks the totals, and writes everything in one transaction; it is idempotent (the
// same export again answers "already imported"; a different one is refused). From then on Pepe reads and moves stashes
// through /api/stash/bot/* and the website does deposits / withdrawals / members / rename / close itself - with or
// without Pepe. Vault staking (stake / unstake into the capital vaults) stays Pepe's: he moves the PAT between a stash
// and his vaults with keyed bot moves.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const MAX_OWNED = 3;
const MAX_MEMBERS = 10;
const MIN_MOVE = 100;
const NAME_RE = /^[a-z0-9_-]{1,20}$/;
const LOGIN_RE = /^[A-Za-z0-9_.\-]{1,60}$/;
const KEY_RE = /^[A-Za-z0-9_.:@-]{6,160}$/;

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}
const low = (s) => String(s || "").trim().replace(/^@+/, "").toLowerCase();
const now = () => Date.now();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS stashes (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0,
        staked INTEGER NOT NULL DEFAULT 0, earned INTEGER NOT NULL DEFAULT 0, created REAL, closed REAL, updated INTEGER,
        CHECK (balance >= 0), CHECK (staked >= 0))`);
      await runQuery("CREATE INDEX IF NOT EXISTS stashes_owner ON stashes (owner)");
      await runQuery(`CREATE TABLE IF NOT EXISTS stash_members (stash_id TEXT NOT NULL, login TEXT NOT NULL, PRIMARY KEY (stash_id, login))`);
      await runQuery("CREATE INDEX IF NOT EXISTS stash_members_login ON stash_members (login)");
      await runQuery(`CREATE TABLE IF NOT EXISTS stash_moves (
        key TEXT PRIMARY KEY, stash_id TEXT, kind TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, staked_delta INTEGER NOT NULL DEFAULT 0,
        login TEXT, user_id TEXT, txid TEXT, via TEXT, ts INTEGER NOT NULL, result TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS stash_moves_stash ON stash_moves (stash_id, ts)");
      await runQuery("CREATE TABLE IF NOT EXISTS stash_meta (key TEXT PRIMARY KEY, value TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM stash_meta WHERE key = ?", [key]))[0];
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
const setMeta = (key, v) => runQuery(`INSERT INTO stash_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                                      [key, JSON.stringify(v)]);

/** May Pepe hand his stashes over? Default: on on staging (STAGING env), off on prod until an admin turns it on. */
async function enabled() {
  const v = await meta("enabled");
  if (v === true || v === false) return v;
  return !!process.env.STAGING;
}
/** The site owns the stashes (the import ran). */
async function live() {
  return !!(await meta("imported"));
}
async function bumpRev() {
  const r = ((await meta("rev")) || 0) + 1;
  await setMeta("rev", r);
  return r;
}

// one money transaction at a time on the shared connection (mainstage's chain, like boosts / stage settles)
const tx = (fn) => require("./mainstage")._tx(fn);

function parseAmount(raw) {
  const t = String(raw == null ? "" : raw).trim().toLowerCase().replace(/[,_ ]/g, "");
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t);
  if (!m) return null;
  const v = Math.floor(Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1));
  return Number.isFinite(v) ? v : null;
}

// ── reads ──
async function membersOf(ids) {
  if (!ids.length) return {};
  const rows = await getQuery(`SELECT stash_id, login FROM stash_members WHERE stash_id IN (${ids.map(() => "?").join(",")}) ORDER BY rowid`, ids);
  const out = {};
  for (const r of rows) (out[r.stash_id] = out[r.stash_id] || []).push(r.login);
  return out;
}
function shape(s, members) {
  return { id: String(s.id), name: s.name, owner: s.owner, members: members || [], balance: Number(s.balance) || 0,
           staked: Number(s.staked) || 0, earned: Number(s.earned) || 0, created: s.created || null, closed: s.closed || null };
}
/** Every stash (closed too with all=true), in Pepe's snapshot shape. */
async function list({ all = false } = {}) {
  await init();
  const rows = await getQuery(`SELECT * FROM stashes ${all ? "" : "WHERE closed IS NULL"} ORDER BY CAST(id AS INTEGER), id`);
  const mem = await membersOf(rows.map((r) => String(r.id)));
  return rows.map((r) => shape(r, mem[String(r.id)]));
}
async function get(id) {
  await init();
  const r = (await getQuery("SELECT * FROM stashes WHERE id = ?", [String(id)]))[0];
  if (!r) return null;
  return shape(r, (await membersOf([String(r.id)]))[String(r.id)]);
}
const canUse = (s, login) => !!login && (low(s.owner) === low(login) || (s.members || []).some((m) => low(m) === low(login)));
const free = (s) => Math.max(0, (Number(s.balance) || 0) - (Number(s.staked) || 0));

/** A stash by the name a user typed: their own first, then ones they can use; "owner/name" disambiguates. */
async function find(login, raw, { ownerOnly = false } = {}) {
  const r = low(raw);
  const slash = r.lastIndexOf("/");
  const ownerHint = slash >= 0 ? r.slice(0, slash) : "";
  const name = slash >= 0 ? r.slice(slash + 1) : r;
  const hits = (await list()).filter((s) => s.name === name && (!ownerHint || low(s.owner) === ownerHint)
    && (!ownerOnly || low(s.owner) === low(login)) && canUse(s, login));
  const mine = hits.filter((s) => low(s.owner) === low(login));
  if (mine.length) return mine[0];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Refuse(409, `More than one stash is called that - say owner/name, e.g. ${hits.slice(0, 3).map((h) => `${h.owner}/${name}`).join(" or ")}.`);
  throw new Refuse(404, `You don't have a stash called '${name}'.`);
}

/** Total PAT in open stashes (the supply's "stashes" row once the site owns them). */
async function total() {
  await init();
  const r = await getQuery("SELECT COALESCE(SUM(balance),0) AS t, COUNT(*) AS n FROM stashes WHERE closed IS NULL");
  return { amount: (r[0] && r[0].t) || 0, count: (r[0] && r[0].n) || 0 };
}

// ── idempotent moves ──
/** In the open transaction: a key seen before -> its first answer (dup), else null. */
async function seen(key) {
  const r = (await getQuery("SELECT result FROM stash_moves WHERE key = ?", [key]))[0];
  if (!r) return null;
  try { return Object.assign(JSON.parse(r.result || "{}"), { dup: true }); } catch (e) { return { ok: true, dup: true }; }
}
async function record(key, row, result) {
  await runQuery(`INSERT INTO stash_moves (key, stash_id, kind, amount, staked_delta, login, user_id, txid, via, ts, result)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [key, row.stash_id || null, row.kind, Math.trunc(row.amount || 0), Math.trunc(row.staked_delta || 0), row.login || null,
                  row.user_id || null, row.txid || null, row.via || null, now(), JSON.stringify(result)]);
}
function checkKey(key) {
  if (!KEY_RE.test(String(key || ""))) throw new Refuse(400, "Bad request (key).");
  return String(key);
}
async function requireLive() {
  if (!(await live())) throw new Refuse(409, "Stashes still live in Pepe - try again in a minute.", "E_NOT_LIVE");
}
async function userIdFor(login) {
  const r = (await getQuery("SELECT userId FROM users WHERE LOWER(camfrogUsername) = LOWER(?) LIMIT 1", [login]))[0];
  return r ? r.userId : null;
}

/** Wallet -> stash. `userId` pays. -> {ok, stash, amount, balance} */
async function deposit({ stashId, login, userId, amount, key, via = "web" }) {
  await requireLive();
  key = checkKey(key);
  const amt = Math.floor(Number(amount));
  if (!(amt >= MIN_MOVE)) throw new Refuse(400, `Move at least ${MIN_MOVE.toLocaleString("en-US")} PAT.`);
  const ledger = require("./ledger");
  return tx(async () => {
    const dup = await seen(key);
    if (dup) return dup;
    const s = (await getQuery("SELECT * FROM stashes WHERE id = ? AND closed IS NULL", [String(stashId)]))[0];
    if (!s) throw new Refuse(404, "That stash doesn't exist (or is closed).");
    const d = await ledger.post(userId, -amt, "stash-deposit", { requireCover: true, source: "stash-deposit" });
    if (!d.ok) throw new Refuse(d.code === ledger.E_INSUFFICIENT ? 402 : 404,
                                d.code === ledger.E_INSUFFICIENT ? "You don't have enough PAT for that." : "Couldn't find your account.",
                                d.code === ledger.E_INSUFFICIENT ? "E_INSUFFICIENT_PAT" : "E_TARGET_NOT_FOUND");
    await runQuery("UPDATE stashes SET balance = balance + ?, updated = ? WHERE id = ?", [amt, now(), s.id]);
    const bal = Number(s.balance) + amt;
    const out = { ok: true, stash: String(s.id), ref: `${s.owner}/${s.name}`, amount: amt, balance: bal };
    await record(key, { stash_id: s.id, kind: "deposit", amount: amt, login, user_id: userId, txid: d.transactionId, via }, out);
    await bumpRev();
    return out;
  });
}

/** Stash -> wallet (the withdrawer's). amount = a number or "all" (everything unstaked). */
async function withdraw({ stashId, login, userId, amount, key, via = "web" }) {
  await requireLive();
  key = checkKey(key);
  const ledger = require("./ledger");
  return tx(async () => {
    const dup = await seen(key);
    if (dup) return dup;
    const s = (await getQuery("SELECT * FROM stashes WHERE id = ? AND closed IS NULL", [String(stashId)]))[0];
    if (!s) throw new Refuse(404, "That stash doesn't exist (or is closed).");
    const f = free(s);
    const amt = String(amount).toLowerCase() === "all" ? f : Math.floor(Number(amount));
    if (!(amt >= 1) || (String(amount).toLowerCase() !== "all" && amt < MIN_MOVE)) {
      throw new Refuse(400, String(amount).toLowerCase() === "all" ? "There's nothing to take out." : `Move at least ${MIN_MOVE.toLocaleString("en-US")} PAT.`);
    }
    if (amt > f) {
      throw new Refuse(409, `${s.owner}/${s.name} has ${f.toLocaleString("en-US")} PAT you can take out` +
                            (Number(s.staked) ? ` (${Number(s.staked).toLocaleString("en-US")} PAT is staked - unstake it first).` : "."), "E_INSUFFICIENT_PAT");
    }
    const u = await runQuery("UPDATE stashes SET balance = balance - ?, updated = ? WHERE id = ? AND balance - staked >= ?", [amt, now(), s.id, amt]);
    if (!u || u.changes !== 1) throw new Refuse(409, "The stash changed - try again.");
    const c = await ledger.post(userId, amt, "stash-withdraw", { resolveMerged: true, source: "stash-withdraw" });
    if (!c.ok) throw new Refuse(404, "Couldn't find the account to pay.", "E_TARGET_NOT_FOUND");   // rolls the stash debit back
    const out = { ok: true, stash: String(s.id), ref: `${s.owner}/${s.name}`, amount: amt, balance: Number(s.balance) - amt };
    await record(key, { stash_id: s.id, kind: "withdraw", amount: -amt, login, user_id: c.userId, txid: c.transactionId, via }, out);
    await bumpRev();
    return out;
  });
}

/**
 * Pepe only: move PAT between a stash and one of HIS pools (vault staking legs, fee-share payouts, the stake lock).
 * amount > 0 = into the stash, < 0 = out of it (only unstaked PAT); staked_delta moves the stake lock
 * (0 <= staked <= balance afterwards). The other side of the move is Pepe's own pool, applied by him.
 */
async function botMove({ stashId, amount = 0, stakedDelta = 0, earned = 0, key, kind = "vault", why = null }) {
  await requireLive();
  key = checkKey(key);
  const amt = Math.trunc(Number(amount) || 0), sd = Math.trunc(Number(stakedDelta) || 0), ea = Math.max(0, Math.trunc(Number(earned) || 0));
  return tx(async () => {
    const dup = await seen(key);
    if (dup) return dup;
    const s = (await getQuery("SELECT * FROM stashes WHERE id = ?", [String(stashId)]))[0];
    if (!s) throw new Refuse(404, "No such stash.", "E_TARGET_NOT_FOUND");
    if (amt < 0 && s.closed) throw new Refuse(409, "That stash is closed.");
    const bal = Number(s.balance) + amt, st = Number(s.staked) + sd;
    if (bal < 0 || st < 0 || st > bal || (amt < 0 && free(s) < -amt && sd >= 0)) {
      return { ok: false, error: "insufficient", balance: Number(s.balance), staked: Number(s.staked) };   // nothing recorded: a retry may succeed later
    }
    await runQuery("UPDATE stashes SET balance = ?, staked = ?, earned = earned + ?, updated = ? WHERE id = ?", [bal, st, ea, now(), s.id]);
    const out = { ok: true, stash: String(s.id), balance: bal, staked: st };
    await record(key, { stash_id: s.id, kind: String(kind).slice(0, 20), amount: amt, staked_delta: sd, via: why ? String(why).slice(0, 60) : "pepe" }, out);
    await bumpRev();
    return out;
  });
}

/** Has this move key been applied? (Pepe asks after a lost answer.) -> the recorded answer or null */
async function moveStatus(key) {
  await init();
  if (!KEY_RE.test(String(key || ""))) return null;
  const r = (await getQuery("SELECT result FROM stash_moves WHERE key = ?", [String(key)]))[0];
  if (!r) return null;
  try { return JSON.parse(r.result || "{}"); } catch (e) { return { ok: true }; }
}

// ── no money: create / members / rename / close ──
async function create({ login, name, by = "web" }) {
  await requireLive();
  name = low(name);
  if (!NAME_RE.test(name)) throw new Refuse(400, "Stash names are 1-20 letters, digits, - or _.");
  if (!LOGIN_RE.test(String(login || ""))) throw new Refuse(400, "Link your Camfrog name first - stashes belong to it.", "E_NOT_LINKED");
  return tx(async () => {
    const owned = await getQuery("SELECT name FROM stashes WHERE owner = ? AND closed IS NULL", [low(login)]);
    if (owned.length >= MAX_OWNED) throw new Refuse(409, `You already own ${owned.length} stashes (max ${MAX_OWNED}).`);
    if (owned.some((s) => s.name === name)) throw new Refuse(409, `You already have a stash called '${name}'.`);
    const seq = Math.max(Number((await meta("seq")) || 0),
                         Number(((await getQuery("SELECT MAX(CAST(id AS INTEGER)) AS m FROM stashes"))[0] || {}).m || 0)) + 1;
    await setMeta("seq", seq);
    await runQuery("INSERT INTO stashes (id, owner, name, balance, staked, earned, created, updated) VALUES (?, ?, ?, 0, 0, 0, ?, ?)",
                   [String(seq), low(login), name, now() / 1000, now()]);
    await bumpRev();
    return { ok: true, stash: shape({ id: seq, owner: low(login), name, balance: 0, staked: 0, earned: 0, created: now() / 1000 }, []), by };
  });
}
async function setMembers({ stashId, who, add }) {
  await requireLive();
  const w = low(who);
  if (!LOGIN_RE.test(w)) throw new Refuse(400, `I don't know who '${who}' is.`);
  return tx(async () => {
    const s = await get(stashId);
    if (!s || s.closed) throw new Refuse(404, "That stash doesn't exist (or is closed).");
    if (add) {
      if (w === low(s.owner)) throw new Refuse(409, "You already own it.");
      if (s.members.some((m) => low(m) === w)) throw new Refuse(409, `${w} already has access.`);
      if (s.members.length >= MAX_MEMBERS) throw new Refuse(409, `A stash can have at most ${MAX_MEMBERS} members.`);
      await runQuery("INSERT INTO stash_members (stash_id, login) VALUES (?, ?)", [s.id, w]);
    } else {
      const r = await runQuery("DELETE FROM stash_members WHERE stash_id = ? AND login = ?", [s.id, w]);
      if (!r || !r.changes) throw new Refuse(404, `${w} doesn't have access.`);
    }
    await runQuery("UPDATE stashes SET updated = ? WHERE id = ?", [now(), s.id]);
    await bumpRev();
    return { ok: true, stash: s.id, who: w, add: !!add };
  });
}
async function rename({ stashId, name }) {
  await requireLive();
  name = low(name);
  if (!NAME_RE.test(name)) throw new Refuse(400, "Stash names are 1-20 letters, digits, - or _.");
  return tx(async () => {
    const s = await get(stashId);
    if (!s || s.closed) throw new Refuse(404, "That stash doesn't exist (or is closed).");
    if ((await getQuery("SELECT 1 FROM stashes WHERE owner = ? AND name = ? AND closed IS NULL AND id != ?", [low(s.owner), name, s.id])).length) {
      throw new Refuse(409, `You already have a stash called '${name}'.`);
    }
    await runQuery("UPDATE stashes SET name = ?, updated = ? WHERE id = ?", [name, now(), s.id]);
    await bumpRev();
    return { ok: true, stash: s.id, old: s.name, name };
  });
}
/**
 * Close: everything unstaked goes to the owner's wallet, then the stash is closed. `stakedForfeit` (Pepe's old
 * fee-share stake, which closing unstakes) - the web refuses while any PAT is staked or in the capital vaults.
 */
async function close({ stashId, ownerUserId, key, via = "web", unstake = false }) {
  await requireLive();
  key = checkKey(key);
  const s0 = await get(stashId);
  if (!s0 || s0.closed) throw new Refuse(404, "That stash doesn't exist (or is closed).");
  if (s0.staked && unstake) await botMove({ stashId: s0.id, stakedDelta: -s0.staked, key: key + ":unstake", kind: "unstake", why: "close" });
  const s = await get(stashId);
  if (s.staked) throw new Refuse(409, `'${s.name}' still has ${s.staked.toLocaleString("en-US")} PAT staked - unstake it first.`);
  let paid = 0;
  if (s.balance > 0) {
    const w = await withdraw({ stashId: s.id, login: s.owner, userId: ownerUserId, amount: "all", key: key + ":empty", via });
    paid = w.amount || 0;
  }
  return tx(async () => {
    const dup = await seen(key);
    if (dup) return dup;
    const r = await runQuery("UPDATE stashes SET closed = ?, updated = ? WHERE id = ? AND closed IS NULL AND balance = 0", [now() / 1000, now(), s.id]);
    if (!r || r.changes !== 1) throw new Refuse(409, "Couldn't empty the stash, so it's still open.");
    const out = { ok: true, stash: s.id, name: s.name, paid };
    await record(key, { stash_id: s.id, kind: "close", amount: 0, login: s.owner, user_id: ownerUserId, via }, out);
    await bumpRev();
    return out;
  });
}

// ── the import (the migration Pepe triggers on deploy) ──
const backupDb = (tag) => require("./dbbackup").backupDb(tag);   // the online backup API, verified - never a file copy

function cleanImport(list) {
  const out = [];
  const ids = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    const id = String(s && s.id != null ? s.id : "").slice(0, 20);
    if (!/^[0-9]{1,12}$/.test(id) || ids.has(id)) throw new Refuse(400, `bad / duplicate stash id ${id}`);
    ids.add(id);
    const name = low(s.name).slice(0, 40), owner = low(s.owner).slice(0, 60);
    const bal = Number(s.balance), st = Number(s.staked || 0), ea = Number(s.earned || 0);
    if (!name || !owner || !Number.isSafeInteger(bal) || bal < 0 || !Number.isSafeInteger(st) || st < 0 || st > bal || !Number.isFinite(ea)) {
      throw new Refuse(400, `stash ${id}: bad fields`);
    }
    out.push({ id, name, owner, balance: bal, staked: st, earned: Math.max(0, Math.floor(ea)),
               members: [...new Set((Array.isArray(s.members) ? s.members : []).map(low).filter((m) => LOGIN_RE.test(m) && m !== owner))].slice(0, 50),
               created: Number(s.created) || null, closed: Number(s.closed) || null });
  }
  return out;
}

/**
 * Pepe's export -> the tables, once. body: {payload: JSON text of [stash...], digest: sha256(payload), seq, total, count}.
 * -> {ok, already?, total, count, backup}. Refused unless enabled, the digest matches, and the totals add up.
 */
async function importFromPepe(body) {
  await init();
  if (!(await enabled())) throw new Refuse(409, "the stash backend is switched off on this site", "E_FEATURE_OFF");
  const payload = String((body && body.payload) || "");
  const digest = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  if (!payload || digest !== String(body.digest || "")) throw new Refuse(400, "digest mismatch");
  const done = await meta("imported");
  if (done) {
    if (done.digest === digest) return { ok: true, already: true, total: done.total, count: done.count, backup: done.backup || null };
    throw new Refuse(409, "stashes were already imported from a different export", "E_ALREADY");
  }
  let list;
  try { list = cleanImport(JSON.parse(payload)); } catch (e) { throw e instanceof Refuse ? e : new Refuse(400, "payload is not JSON"); }
  const tot = list.filter((s) => !s.closed).reduce((t, s) => t + s.balance, 0);
  if (tot !== Math.floor(Number(body.total)) || list.length !== Math.floor(Number(body.count))) {
    throw new Refuse(400, `totals don't match: ${tot} PAT in ${list.length} stashes vs ${body.total} / ${body.count}`);
  }
  if ((await getQuery("SELECT COUNT(*) AS n FROM stashes"))[0].n > 0) throw new Refuse(409, "the stashes table isn't empty - refusing to import over it");
  const backup = await backupDb("pre-stash-import");
  const seq = Math.max(Math.floor(Number(body.seq) || 0), ...list.map((s) => Number(s.id)), 0);
  await tx(async () => {
    if (await meta("imported")) throw new Refuse(409, "already imported");          // lost a race with its twin
    for (const s of list) {
      await runQuery(`INSERT INTO stashes (id, owner, name, balance, staked, earned, created, closed, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                     [s.id, s.owner, s.name, s.balance, s.staked, s.earned, s.created, s.closed, now()]);
      for (const m of s.members) await runQuery("INSERT OR IGNORE INTO stash_members (stash_id, login) VALUES (?, ?)", [s.id, m]);
    }
    const check = (await getQuery("SELECT COALESCE(SUM(balance),0) AS t, COUNT(*) AS n FROM stashes"))[0];
    const open = (await getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM stashes WHERE closed IS NULL"))[0].t;
    if (check.n !== list.length || open !== tot) throw new Refuse(500, "the imported totals didn't verify - rolled back");
    await setMeta("seq", seq);
    await setMeta("imported", { at: now(), digest, total: tot, count: list.length, backup });
    await bumpRev();
  });
  console.log(`[stashes] imported ${list.length} stash(es) holding ${tot} PAT from Pepe (backup ${backup})`);
  return { ok: true, total: tot, count: list.length, backup };
}

// ── the website's /act stash form (wallet.ejs) ──
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
/**
 * A wallet-page stash form (args after "stash", as typed in chat). -> the message to show, or null = not the site's
 * to do (vault stake / unstake / yield stay Pepe's - the caller queues those for him as before).
 */
async function fromForm(userId, words, idem) {
  if (!(await live())) return null;
  const sub = low(words[0] || "list");
  if (["stake", "unstake", "yield", "vaults"].includes(sub)) return null;
  const u = (await getQuery("SELECT username, camfrogUsername FROM users WHERE userId = ?", [userId]))[0];
  if (!u) return "Couldn't find your account.";
  const me = u.camfrogUsername;
  if (!me) return "Link your Camfrog name first (type !verify in a Camfrog room) - stashes belong to it.";
  const key = (op) => `web:${userId}:${op}:${/^[A-Za-z0-9_-]{8,64}$/.test(String(idem || "")) ? idem : crypto.randomBytes(9).toString("hex")}`;
  try {
    if (sub === "create" || sub === "new" || sub === "open") {
      const r = await create({ login: me, name: words[1] });
      return `🔐 Stash '${r.stash.name}' created. Deposit into it below; grant someone access to share it.`;
    }
    if (["deposit", "in", "put", "store"].includes(sub)) {
      const s = await find(me, words[1]);
      const amt = parseAmount(words[2]);
      if (!amt) return `Move at least ${fmt(MIN_MOVE)} PAT.`;
      const r = await deposit({ stashId: s.id, login: me, userId, amount: amt, key: key("deposit") });
      return r.dup ? "Already done - that deposit went through once." : `🔐 Deposited ${fmt(r.amount)} PAT into ${r.ref} - balance ${fmt(r.balance)} PAT.`;
    }
    if (["withdraw", "out", "take"].includes(sub)) {
      const s = await find(me, words[1]);
      const raw = low(words[2]) === "all" ? "all" : parseAmount(words[2]);
      if (!raw) return `Move at least ${fmt(MIN_MOVE)} PAT.`;
      const r = await withdraw({ stashId: s.id, login: me, userId, amount: raw, key: key("withdraw") });
      return r.dup ? "Already done - that withdrawal went through once." : `🔐 Withdrew ${fmt(r.amount)} PAT from ${r.ref} to your wallet. Left: ${fmt(r.balance)} PAT.`;
    }
    if (["grant", "share", "allow", "add", "revoke", "remove", "unshare", "kick"].includes(sub)) {
      const add = ["grant", "share", "allow", "add"].includes(sub);
      const s = await find(me, words[1], { ownerOnly: true });
      const r = await setMembers({ stashId: s.id, who: words[2], add });
      return `🔐 ${r.who} ${add ? "can now use" : "no longer has access to"} ${s.owner}/${s.name}.`;
    }
    if (sub === "rename") {
      const s = await find(me, words[1], { ownerOnly: true });
      const r = await rename({ stashId: s.id, name: words[2] });
      return `🔐 '${r.old}' is now '${r.name}'.`;
    }
    if (sub === "close" || sub === "delete") {
      const s = await find(me, words[1], { ownerOnly: true });
      const sk = await require("./staking").latest().catch(() => null);
      const p = require("./staking").positionFor(sk, s);
      const pend = ((sk && sk.queue) || []).some((q) => String(q.stash) === String(s.id) && !["done", "failed"].includes(q.state));
      if ((p && require("./staking").holdValue(p) > 0) || pend) {
        return `🔐 '${s.name}' still has PAT staked in the vaults - unstake it all first (it comes back at the next cut-off).`;
      }
      const r = await close({ stashId: s.id, ownerUserId: userId, key: key("close") });
      return `🔐 Stash '${r.name}' closed` + (r.paid ? ` - ${fmt(r.paid)} PAT sent to your wallet.` : ".");
    }
    const mine = (await list()).filter((s) => canUse(s, me));
    if (!mine.length) return "🔐 No stashes yet - create one below.";
    return mine.slice(0, 6).map((s) => `🔐 ${s.owner}/${s.name}: ${fmt(s.balance)} PAT`).join(" · ");
  } catch (e) {
    if (e instanceof Refuse) return e.message;
    console.error("[stashes] form:", e);
    return "Something went wrong - nothing was moved.";
  }
}

// ── routes ──
function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[stashes] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (e instanceof Refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      console.error("[stashes] bot:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  // POST so the staging router falls back to Pepe's sandbox when the staging site is down
  app.post("/api/stash/bot/status", bot(async () => ({ ok: true, enabled: await enabled(), live: await live(),
                                                       imported: await meta("imported"), rev: (await meta("rev")) || 0 })));
  app.post("/api/stash/bot/import", bot((b) => importFromPepe(b)));
  app.post("/api/stash/bot/state", bot(async (b) => {
    const rev = (await meta("rev")) || 0;
    if (b.since_rev !== undefined && Number(b.since_rev) === rev) return { ok: true, live: await live(), rev, same: true };
    return { ok: true, live: await live(), rev, stashes: await list({ all: true }), seq: (await meta("seq")) || 0 };
  }));
  app.post("/api/stash/bot/act", bot(async (b) => {
    const op = String(b.op || "");
    const login = low(b.login);
    if (op === "create") return create({ login, name: b.name, by: "pepe" });
    if (op === "members") return setMembers({ stashId: b.stash, who: b.who, add: !!b.add });
    if (op === "rename") return rename({ stashId: b.stash, name: b.name });
    if (op === "move") return botMove({ stashId: b.stash, amount: b.amount, stakedDelta: b.staked_delta, earned: b.earned, key: b.key, kind: b.kind, why: b.why });
    if (op === "move_status") return { ok: true, result: await moveStatus(b.key) };
    // money moves for a Camfrog user: Pepe resolved the account (b.username) and checked access with his alias rules
    const uid = b.username ? ((await getQuery("SELECT userId FROM users WHERE username = ?", [String(b.username)]))[0] || {}).userId : null;
    if (op === "deposit" || op === "withdraw" || op === "close") {
      if (!uid) throw new Refuse(404, "couldn't find a PAT account", "E_TARGET_NOT_FOUND");
      if (op === "deposit") return deposit({ stashId: b.stash, login, userId: uid, amount: b.amount, key: b.key, via: "chat" });
      if (op === "withdraw") return withdraw({ stashId: b.stash, login, userId: uid, amount: b.amount, key: b.key, via: "chat" });
      return close({ stashId: b.stash, ownerUserId: uid, key: b.key, via: "chat", unstake: !!b.unstake });
    }
    throw new Refuse(400, "unknown op");
  }));
  // admins: switch the backend on/off before the import (after it, the site owns the stashes for good)
  app.post("/api/admin/stash-backend", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!row || row.class !== "Admin") return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    await init();
    if (await live()) return res.status(409).json({ ok: false, error: "Already imported - the site owns the stashes now." });
    await setMeta("enabled", !!(req.body || {}).on);
    res.json({ ok: true, enabled: await enabled() });
  });
}

module.exports = { init, register, enabled, live, list, get, find, total, deposit, withdraw, botMove, moveStatus, create, setMembers,
                   rename, close, importFromPepe, fromForm, parseAmount, canUse, free, userIdFor, Refuse, MIN_MOVE, MAX_OWNED };
