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
//                                             returns the first answer instead of moving twice. PO-0b: a refused bot
//                                             move is recorded too (kind "refused", amount 0) - terminal for its key
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
//
// 1.99wy: a stash belongs to a PATV ACCOUNT, not a chat login. `stashes.owner` and `stash_members.login` hold a holder
// key: "u:<userId>" for an account, or a bare chat login (lower case) only for a login no PATV account has linked yet
// (it moves to "u:<userId>" the moment an account links it - loginrekey.changed -> claimLogin). Why it was still a login
// until now: the 1.99ne hand-over imported Pepe's pvaults.json as it was (his stashes were keyed by the login that typed
// `!stash create`), and nothing re-keyed them afterwards. tools/stash-rekey.js moves existing rows (one keyed
// transaction; balances, stake locks, the vault book and every NAV exactly unchanged). Every reader takes both forms, so
// the code is right before and after that one-off.
//   * the website acts as the signed-in account (no chat login needed); chat commands arrive from Pepe with the login
//     (and the account Pepe resolved for it) - the site maps the login to its account through the link (resolveRecord)
//     and checks access by account (owner / member) itself.
//   * what Pepe sees (bot/state, the export): `owner` / `members` are the holders' CHAT keys - the linked login, else
//     "u:<userId>" (Pepe's account nick, 1.99wt) - so his mirror, his `owner/name` refs and a detach to local mode keep
//     working; `owner_id` / `owner_name` / `member_names` name the accounts.
// The vault book (capital/vaults.js) holds shares per STASH ("s<id>"), so staking follows the stash's owner account.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

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

// ── 1.99wy: holder keys (an account "u:<userId>", or a bare chat login no account has linked yet) ──
const ACCT_RE = /^u:([A-Za-z0-9_-]{1,64})$/;
const acctKey = (userId) => `u:${userId}`;
const uidOfKey = (k) => { const m = ACCT_RE.exec(String(k || "").trim()); return m ? m[1] : null; };
const isAcctKey = (k) => !!uidOfKey(k);
/** A stored key in its canonical form: account keys keep their case (ids), logins are lower case. */
const normKey = (k) => (isAcctKey(k) ? String(k).trim() : low(k));
const stripGlobe = (s) => String(s || "").trim().replace(/^@+/, "").replace(/^\u{1F310}\s*/u, "");
const ACOLS = "userId, username, camfrogUsername";

/**
 * What a holder key stands for NOW: {key, userId, username, login, chat} - `chat` is the key Pepe uses for it (the linked
 * login, else "u:<userId>"; a bare login with no account stays itself). An account key follows merges. `cache` (a Map)
 * is shared by one listing.
 */
async function holderInfo(key, cache = null) {
  const k = normKey(key);
  if (cache && cache.has(k)) return cache.get(k);
  let out = { key: k, userId: null, username: null, login: null, chat: k };
  const uid = uidOfKey(k);
  if (uid) {
    const id = (await require("./usernames").resolveUserId(uid)) || null;
    const u = id ? (await getQuery(`SELECT ${ACOLS} FROM users WHERE userId = ?`, [id]))[0] : null;
    if (u) out = { key: k, userId: u.userId, username: u.username, login: low(u.camfrogUsername) || null, chat: low(u.camfrogUsername) || acctKey(u.userId) };
  } else if (k) {
    const u = await getQuery(`SELECT ${ACOLS} FROM users WHERE lower(trim(camfrogUsername)) = ? LIMIT 2`, [k]);
    if (u.length === 1) out = { key: k, userId: u[0].userId, username: u[0].username, login: k, chat: k };
  }
  if (cache) cache.set(k, out);
  return out;
}

/**
 * The actor of a stash command: {userId, username, login, keys} - `keys` are the holder keys that are THIS actor (its
 * account key and, for a row not re-keyed yet, its linked login). From the website: {userId}. From Pepe: the account he
 * resolved for the nick (userId / username) and/or the chat login - the site maps a login to its account through the
 * link (an account nick "u:<id>" is that account). A login with no account is just itself.
 */
async function actorOf({ userId = null, username = null, login = null } = {}) {
  const U = require("./usernames");
  const lg = login == null ? "" : String(login).trim().replace(/^@+/, "");
  const nickUid = uidOfKey(lg);
  let row = null;
  if (userId || nickUid) {
    const r = await U.resolveRecord({ userId: userId || nickUid }, { cols: ACOLS });
    if (r.ok) row = r.user;
  }
  if (!row && lg && !nickUid) {
    const r = await U.resolveLogin(lg, { cols: ACOLS });
    if (r.ok) row = r.user;
  }
  if (!row && username) {
    const r = await U.resolve(String(username), { cols: ACOLS });
    if (r.ok) row = r.user;
  }
  if (row) {
    const keys = new Set([acctKey(row.userId)]);
    if (row.camfrogUsername) keys.add(low(row.camfrogUsername));
    return { userId: row.userId, username: row.username, login: low(row.camfrogUsername) || null, keys };
  }
  const bare = nickUid ? "" : low(lg);
  const ok = LOGIN_RE.test(bare);
  return { userId: null, username: null, login: ok ? bare : null, keys: new Set(ok ? [bare] : []) };
}
/** The key a NEW holder row gets for this actor: its account, else its bare login. */
const holderKeyOf = (actor) => (actor && actor.userId ? acctKey(actor.userId) : (actor && actor.login) || null);
/** A plain login string where an actor is expected (older callers): a login-only actor. */
const asActor = (a) => (a && a.keys instanceof Set ? a
  : { userId: null, username: null, login: low(a) || null, keys: new Set(low(a) ? [low(a)] : []) });
/** The account a typed name means (a member to grant / revoke): "u:<id>", a linked chat login, a PATV username, else a
 *  bare chat login. -> {key, keys, userId, label} | null */
async function holderFor(who) {
  const w = stripGlobe(who);
  if (!w) return null;
  let a = await actorOf({ login: w });
  if (!a.userId && !isAcctKey(w)) {
    const r = await require("./usernames").resolve(w, { cols: ACOLS });
    if (r.ok) a = await actorOf({ userId: r.user.userId });
  }
  if (a.userId) return { key: acctKey(a.userId), keys: a.keys, userId: a.userId, label: a.login || a.username };
  if (isAcctKey(w)) return null;
  const b = low(w);
  return LOGIN_RE.test(b) ? { key: b, keys: new Set([b]), userId: null, label: b } : null;
}

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
/** bumpRev for callers inside OTHER modules' transactions (login re-key, merges): never creates tables there (a rolled-back
 *  CREATE would leave init() memoized without them) - only bumps when stash_meta exists. */
async function bumpRevQuiet() {
  if (!(await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stash_meta'")).length) return;
  await runQuery(`INSERT INTO stash_meta (key, value) VALUES ('rev', '1')
                  ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`);
}
async function bumpRev() {
  const r = ((await meta("rev")) || 0) + 1;
  await setMeta("rev", r);
  return r;
}

// one money transaction at a time on the shared connection (dbUtils.tx: the one chain every module shares)
const tx = (fn) => require("./dbUtils").tx(fn);

// 1.99nk: the shared PAT-amount parser (public/js/patamount.js = Pepe's pepe_amount rules): 1,000,000 / 5k / 1.5m / 1b
function parseAmount(raw) {
  const v = require("./public/js/patamount").parse(raw);
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
/**
 * One stash for readers. `owner` / `members` are CHAT keys (what Pepe and his mirror use: the linked login, else
 * "u:<userId>"); `owner_key` / `member_keys` are the stored holder keys; `owner_id` / `owner_name` (+ member_ids /
 * member_names) name the accounts (null id = a chat login no account has linked yet).
 */
async function shape(s, memberKeys, cache) {
  const o = await holderInfo(s.owner, cache);
  const ms = [];
  for (const m of memberKeys || []) ms.push(await holderInfo(m, cache));
  return { id: String(s.id), name: s.name, owner: o.chat, owner_key: o.key, owner_id: o.userId, owner_name: o.username || o.chat,
           members: ms.map((m) => m.chat), member_keys: ms.map((m) => m.key), member_ids: ms.map((m) => m.userId),
           member_names: ms.map((m) => m.username || m.chat),
           balance: Number(s.balance) || 0, staked: Number(s.staked) || 0, earned: Number(s.earned) || 0,
           created: s.created || null, closed: s.closed || null };
}
/** Every stash (closed too with all=true). */
async function list({ all = false } = {}) {
  await init();
  const rows = await getQuery(`SELECT * FROM stashes ${all ? "" : "WHERE closed IS NULL"} ORDER BY CAST(id AS INTEGER), id`);
  const mem = await membersOf(rows.map((r) => String(r.id)));
  const cache = new Map();
  const out = [];
  for (const r of rows) out.push(await shape(r, mem[String(r.id)], cache));
  return out;
}
async function get(id) {
  await init();
  const r = (await getQuery("SELECT * FROM stashes WHERE id = ?", [String(id)]))[0];
  if (!r) return null;
  return shape(r, (await membersOf([String(r.id)]))[String(r.id)], new Map());
}
/** Is `actor` (actorOf(), or a plain login) this stash's owner? By account when both are known, else by key. */
function isOwner(s, actor) {
  const a = asActor(actor);
  if (!s) return false;
  if (a.userId && s.owner_id && s.owner_id === a.userId) return true;
  const k = s.owner_key !== undefined ? s.owner_key : normKey(s.owner);
  return a.keys.has(normKey(k)) || (s.owner_key !== undefined && a.keys.has(low(s.owner)));
}
/** May `actor` use this stash (owner or member)? */
function canUse(s, actor) {
  const a = asActor(actor);
  if (!s || !a.keys.size) return false;
  if (isOwner(s, a)) return true;
  if (a.userId && (s.member_ids || []).some((id) => id && id === a.userId)) return true;
  const keys = (s.member_keys || []).concat(s.members || []);
  return keys.some((m) => a.keys.has(normKey(m)));
}
/** "owner/name" for a raw stashes row, with the owner's PATV username. */
const refOf = async (row) => { const o = await holderInfo(row.owner); return `${o.username || o.chat}/${row.name}`; };
const free = (s) => Math.max(0, (Number(s.balance) || 0) - (Number(s.staked) || 0));
/** How someone typed an owner ("owner/name"): the chat key, the PATV username, the stored key (a leading 🌐 is ignored). */
const ownerMatches = (s, hint) => {
  const h = low(stripGlobe(hint));
  return [s.owner, s.owner_name, s.owner_key].some((x) => x && low(x) === h);
};

/** A stash by the name a user typed: their own first, then ones they can use; "owner/name" disambiguates. */
async function find(actor, raw, { ownerOnly = false } = {}) {
  const a = actor && actor.keys instanceof Set ? actor : (await actorOf({ login: actor }));
  const r = low(raw);
  const slash = r.lastIndexOf("/");
  const ownerHint = slash >= 0 ? r.slice(0, slash) : "";
  const name = slash >= 0 ? r.slice(slash + 1) : r;
  const hits = (await list()).filter((s) => s.name === name && (!ownerHint || ownerMatches(s, ownerHint))
    && (!ownerOnly || isOwner(s, a)) && canUse(s, a));
  const mine = hits.filter((s) => isOwner(s, a));
  if (mine.length) return mine[0];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Refuse(409, `More than one stash is called that - say owner/name, e.g. ${hits.slice(0, 3).map((h) => `${h.owner_name}/${name}`).join(" or ")}.`);
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
    const out = { ok: true, stash: String(s.id), ref: await refOf(s), amount: amt, balance: bal };
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
      throw new Refuse(409, `${await refOf(s)} has ${f.toLocaleString("en-US")} PAT you can take out` +
                            (Number(s.staked) ? ` (${Number(s.staked).toLocaleString("en-US")} PAT is staked - unstake it first).` : "."), "E_INSUFFICIENT_PAT");
    }
    const u = await runQuery("UPDATE stashes SET balance = balance - ?, updated = ? WHERE id = ? AND balance - staked >= ?", [amt, now(), s.id, amt]);
    if (!u || u.changes !== 1) throw new Refuse(409, "The stash changed - try again.");
    const c = await ledger.post(userId, amt, "stash-withdraw", { resolveMerged: true, source: "stash-withdraw" });
    if (!c.ok) throw new Refuse(404, "Couldn't find the account to pay.", "E_TARGET_NOT_FOUND");   // rolls the stash debit back
    const out = { ok: true, stash: String(s.id), ref: await refOf(s), amount: amt, balance: Number(s.balance) - amt };
    await record(key, { stash_id: s.id, kind: "withdraw", amount: -amt, login, user_id: c.userId, txid: c.transactionId, via }, out);
    await bumpRev();
    return out;
  });
}

/**
 * Pepe only: move PAT between a stash and one of HIS pools (vault staking legs, fee-share payouts, the stake lock).
 * amount > 0 = into the stash, < 0 = out of it (only unstaked PAT); staked_delta moves the stake lock
 * (0 <= staked <= balance afterwards). The other side of the move is Pepe's own pool, applied by him.
 *
 * PO-0b (economy policy plan §2.4, T6): EVERY answer is recorded under the key and is terminal for it - "paid", or
 * "refused" with its reason: not enough unstaked PAT (HTTP 200 {ok:false, error:"insufficient"} as before), no such stash
 * (404) or a closed stash's debit / stake change (409). A later attempt with the same key - the original Pepe gave up on,
 * still in flight, arriving after his refund went out - gets that same answer and moves nothing: exactly one movement.
 * A deliberate retry uses a NEW key. The refusal row is kind "refused", amount 0 (no reader of stash_moves counts it).
 * The HTTP status codes are what they were (the bot route answers `status`). In-site callers (capital cut-off / requests,
 * policy/apply) throw on a refusal, so their transaction - and the refusal row with it - rolls back as before.
 *   (a) the owner's 2026-10-20 rule: a CREDIT that reaches a stash its owner already closed goes to the owner's WALLET
 * (one ledger post in the same transaction, recorded under the key with to_wallet) - never stranded in a closed stash.
 * A closed stash whose owner has no PATV account refuses it (409, recorded) so Pepe's refund puts it back at its source.
 * Until PO-0c Pepe has no refund for a refused WATERFALL stash leg (_tr_finish resends it every tick and his week never
 * finishes) - the deploy gate: tools/policy-backend.js lists the closed stashes with no account to pay and the waterfall
 * legs refused lately. In-site callers: a capital cut-off step fails alone (vaults.guarded: that queue item is left for the
 * next cut-off, the rest commits); a site-run epoch never targets a closed stash (gather marks them, engines.stakers pays
 * open ones only, and the run reads and moves in one transaction).
 *   (c) requireLive is checked INSIDE the transaction (after the dedup, which answers a recorded key whatever happens).
 */
async function botMove({ stashId, amount = 0, stakedDelta = 0, earned = 0, key, kind = "vault", why = null }) {
  await init();
  key = checkKey(key);
  const amt = Math.trunc(Number(amount) || 0), sd = Math.trunc(Number(stakedDelta) || 0), ea = Math.max(0, Math.trunc(Number(earned) || 0));
  const via = why ? String(why).slice(0, 60) : "pepe";
  return tx(async () => {
    const dup = await seen(key);
    if (dup) return dup;
    await requireLive();
    const refuse = async (s, out) => {
      await record(key, { stash_id: s ? s.id : (String(stashId == null ? "" : stashId).slice(0, 20) || null), kind: "refused", amount: 0, via }, out);
      return out;
    };
    const s = (await getQuery("SELECT * FROM stashes WHERE id = ?", [String(stashId)]))[0];
    if (!s) return refuse(null, { ok: false, error: "No such stash.", code: "E_TARGET_NOT_FOUND", status: 404 });
    if (s.closed && amt > 0 && sd === 0) return closedCredit(s, { amt, ea, key, kind, via, refuse });
    if (s.closed && (amt !== 0 || sd !== 0)) return refuse(s, { ok: false, error: "That stash is closed.", code: "E_STASH_CLOSED", status: 409 });
    const bal = Number(s.balance) + amt, st = Number(s.staked) + sd;
    if (bal < 0 || st < 0 || st > bal || (amt < 0 && free(s) < -amt && sd >= 0)) {
      return refuse(s, { ok: false, error: "insufficient", balance: Number(s.balance), staked: Number(s.staked) });
    }
    await runQuery("UPDATE stashes SET balance = ?, staked = ?, earned = earned + ?, updated = ? WHERE id = ?", [bal, st, ea, now(), s.id]);
    const out = { ok: true, stash: String(s.id), balance: bal, staked: st };
    if (ea) out.earned = ea;            // staking fix plan P0.2: the journal says it counted (tools/staking-backfill.js earned skips it)
    await record(key, { stash_id: s.id, kind: String(kind).slice(0, 20), amount: amt, staked_delta: sd, via }, out);
    await bumpRev();
    return out;
  });
}
/** (a) In botMove's transaction: a credit for a CLOSED stash is paid to its owner's wallet (the closed row keeps balance 0;
 *  `earned` still counts a staking payout, like an open stash's). No account to pay -> a recorded 409 (Pepe refunds it). */
async function closedCredit(s, { amt, ea, key, kind, via, refuse }) {
  const o = await holderInfo(s.owner);
  const c = o.userId ? await require("./ledger").post(o.userId, amt, "stash-closed-credit", { resolveMerged: true, source: "stash-closed" }) : null;
  if (!c || !c.ok) {
    return refuse(s, { ok: false, error: "That stash is closed and its owner has no PATV account to pay.", code: "E_STASH_CLOSED", status: 409 });
  }
  if (ea) await runQuery("UPDATE stashes SET earned = earned + ?, updated = ? WHERE id = ?", [ea, now(), s.id]);
  const out = { ok: true, stash: String(s.id), balance: Number(s.balance) || 0, staked: Number(s.staked) || 0, to_wallet: true, amount: amt, user_id: c.userId };
  if (ea) out.earned = ea;
  await record(key, { stash_id: s.id, kind: String(kind).slice(0, 20), amount: amt, staked_delta: 0, login: o.login, user_id: c.userId,
                      txid: c.transactionId, via }, out);
  await bumpRev();
  console.log(`[stashes] ${key}: stash ${s.id} is closed - ${amt} PAT paid to its owner's wallet (${c.userId})`);
  return out;
}
/** PO-0b: what a recorded answer stands for - "paid" (it moved), "refused" (answered and terminal for its key) or
 *  "unknown" (nothing recorded under the key, yet: never a refusal - the original may still be on its way). */
const stateOf = (r) => (!r ? "unknown" : r.ok === false ? "refused" : "paid");

/** Has this move key been applied? (Pepe asks after a lost answer.) -> the recorded answer or null */
async function moveStatus(key) {
  await init();
  if (!KEY_RE.test(String(key || ""))) return null;
  const r = (await getQuery("SELECT result FROM stash_moves WHERE key = ?", [String(key)]))[0];
  if (!r) return null;
  try { return JSON.parse(r.result || "{}"); } catch (e) { return { ok: true }; }
}

/**
 * 1.99adl: Pepe's move_status (op "move_status") - the same answer, read in a transaction of its own on the chain. A plain
 * read is never held at the write gate and the connection is shared, so it could (a) say "not recorded" while the move
 * Pepe gave up on is still queued behind the gate (it commits a moment later), and (b) see an OPEN transaction's
 * uncommitted stash_moves row - "landed" - which a rollback (a COMMIT error, a restart mid-transaction) then takes back
 * after Pepe already counted it as paid. Queued behind every transaction that was already waiting, it answers for the
 * moves that reached the site before it, from committed rows only.
 */
async function settledMoveStatus(key) {
  await init();
  if (!KEY_RE.test(String(key || ""))) return null;
  return tx(() => moveStatus(key));
}

// ── no money: create / members / rename / close ──
/** The open stashes held under any of these keys (one account's: its "u:<id>" + a not-yet-re-keyed login). */
async function ownedBy(keys) {
  const ks = [...keys].map((k) => low(k)).filter(Boolean);
  if (!ks.length) return [];
  return getQuery(`SELECT id, name FROM stashes WHERE closed IS NULL AND lower(owner) IN (${ks.map(() => "?").join(",")})`, ks);
}
/** `actor` (actorOf()) or, for older callers, `login` (resolved to its account through the link). */
async function create({ login, actor, name, by = "web" }) {
  await requireLive();
  name = low(name);
  if (!NAME_RE.test(name)) throw new Refuse(400, "Stash names are 1-20 letters, digits, - or _.");
  const a = actor && actor.keys instanceof Set ? actor : await actorOf({ login });
  const ownerKey = holderKeyOf(a);
  if (!ownerKey) throw new Refuse(400, "Couldn't find your PATV account.", "E_TARGET_NOT_FOUND");
  return tx(async () => {
    const owned = await ownedBy(a.keys);
    if (owned.length >= MAX_OWNED) throw new Refuse(409, `You already own ${owned.length} stashes (max ${MAX_OWNED}).`);
    if (owned.some((s) => s.name === name)) throw new Refuse(409, `You already have a stash called '${name}'.`);
    const seq = Math.max(Number((await meta("seq")) || 0),
                         Number(((await getQuery("SELECT MAX(CAST(id AS INTEGER)) AS m FROM stashes"))[0] || {}).m || 0)) + 1;
    await setMeta("seq", seq);
    await runQuery("INSERT INTO stashes (id, owner, name, balance, staked, earned, created, updated) VALUES (?, ?, ?, 0, 0, 0, ?, ?)",
                   [String(seq), ownerKey, name, now() / 1000, now()]);
    await bumpRev();
    return { ok: true, stash: await get(String(seq)), by };
  });
}
async function setMembers({ stashId, who, add }) {
  await requireLive();
  const h = await holderFor(who);
  if (!h) throw new Refuse(400, `I don't know who '${who}' is.`);
  return tx(async () => {
    const s = await get(stashId);
    if (!s || s.closed) throw new Refuse(404, "That stash doesn't exist (or is closed).");
    const isThem = (key, id) => (h.userId && id && id === h.userId) || h.keys.has(normKey(key));
    if (add) {
      if (isThem(s.owner_key, s.owner_id)) throw new Refuse(409, "You already own it.");
      if (s.member_keys.some((m, i) => isThem(m, s.member_ids[i]))) throw new Refuse(409, `${h.label} already has access.`);
      if (s.members.length >= MAX_MEMBERS) throw new Refuse(409, `A stash can have at most ${MAX_MEMBERS} members.`);
      await runQuery("INSERT INTO stash_members (stash_id, login) VALUES (?, ?)", [s.id, h.key]);
    } else {
      let n = 0;
      for (let i = 0; i < s.member_keys.length; i++) {
        if (!isThem(s.member_keys[i], s.member_ids[i])) continue;
        const r = await runQuery("DELETE FROM stash_members WHERE stash_id = ? AND lower(login) = lower(?)", [s.id, s.member_keys[i]]);
        n += (r && r.changes) || 0;
      }
      if (!n) throw new Refuse(404, `${h.label} doesn't have access.`);
    }
    await runQuery("UPDATE stashes SET updated = ? WHERE id = ?", [now(), s.id]);
    await bumpRev();
    return { ok: true, stash: s.id, who: h.label, who_key: h.key, add: !!add };
  });
}
async function rename({ stashId, name }) {
  await requireLive();
  name = low(name);
  if (!NAME_RE.test(name)) throw new Refuse(400, "Stash names are 1-20 letters, digits, - or _.");
  return tx(async () => {
    const s = await get(stashId);
    if (!s || s.closed) throw new Refuse(404, "That stash doesn't exist (or is closed).");
    const ownerKeys = s.owner_id ? (await actorOf({ userId: s.owner_id })).keys : new Set([s.owner_key]);
    if ((await ownedBy(ownerKeys)).some((x) => x.name === name && String(x.id) !== String(s.id))) {
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
    await rekeyInTx();                                                              // 1.99wy: held by accounts from the start
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

// ── 1.99wy: login keys -> account keys ──
/** The key a stored holder key should have now: an account key follows merges; a login maps to the account linked to it
 *  NOW (the link; 1.99tj - never through the login history); a login no account has stays itself. -> {to, why} */
async function targetKey(key) {
  const k = normKey(key);
  const uid = uidOfKey(k);
  if (uid) {
    const id = await require("./usernames").resolveUserId(uid);
    return id ? { to: acctKey(id), why: id === uid ? "account" : "merged account" } : { to: k, why: "account not found (kept)" };
  }
  const r = await require("./usernames").resolveLogin(k, { cols: "userId" });
  return r.ok ? { to: acctKey(r.user.userId), why: "linked login" } : { to: k, why: r.code === "E_AMBIGUOUS" ? "login on 2+ accounts (kept)" : "no account (kept)" };
}

/**
 * Inside the caller's transaction: every owner / member key to its account key (targetKey). A member who is the owner's
 * own account is dropped (the owner isn't a member), and so is a second row for the same account. Balances, stake
 * locks, ids, names, the move journal and the vault book are not touched. -> {owners: [...], members: [...], kept: [...]}
 */
async function rekeyInTx() {
  const out = { owners: [], members: [], kept: [] };
  const cache = new Map();
  const tk = async (k) => { if (!cache.has(k)) cache.set(k, await targetKey(k)); return cache.get(k); };
  const owners = {};
  for (const s of await getQuery("SELECT id, owner FROM stashes ORDER BY CAST(id AS INTEGER), id")) {
    const t = await tk(s.owner);
    owners[String(s.id)] = t.to;
    if (t.to !== s.owner) {
      const u = await runQuery("UPDATE stashes SET owner = ? WHERE id = ? AND owner = ?", [t.to, s.id, s.owner]);
      if (!u || u.changes !== 1) throw new Refuse(409, `stash ${s.id} changed during the re-key`);
      out.owners.push({ stash: String(s.id), from: s.owner, to: t.to, why: t.why });
    } else if (!isAcctKey(t.to)) out.kept.push({ stash: String(s.id), role: "owner", key: s.owner, why: t.why });
  }
  for (const m of await getQuery("SELECT stash_id, login FROM stash_members ORDER BY stash_id, rowid")) {
    const t = await tk(m.login);
    const sid = String(m.stash_id);
    const drop = t.to === owners[sid] ? "the owner's own account" : null;
    if (t.to === m.login && !drop) { if (!isAcctKey(t.to)) out.kept.push({ stash: sid, role: "member", key: m.login, why: t.why }); continue; }
    await runQuery("DELETE FROM stash_members WHERE stash_id = ? AND login = ?", [m.stash_id, m.login]);
    let why = drop;
    if (!drop) {
      const ins = await runQuery("INSERT OR IGNORE INTO stash_members (stash_id, login) VALUES (?, ?)", [m.stash_id, t.to]);
      if (!ins || !ins.changes) why = "already a member as that account";
    }
    out.members.push({ stash: sid, from: m.login, to: why ? null : t.to, why: why || t.why });
  }
  if (out.owners.length || out.members.length) await bumpRev();
  return out;
}

/** The exact state the re-key must leave unchanged, per stash + totals (+ a digest). Read inside the transaction. */
async function moneyFacts() {
  const rows = await getQuery("SELECT id, name, balance, staked, earned, created, closed FROM stashes ORDER BY CAST(id AS INTEGER), id");
  const moves = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS a, COALESCE(SUM(staked_delta),0) AS sd FROM stash_moves"))[0];
  const open = rows.filter((r) => r.closed == null);
  const facts = { stashes: rows.map((r) => [String(r.id), r.name, Number(r.balance), Number(r.staked), Number(r.earned), r.created, r.closed]),
                  count: rows.length, open: open.length, total: open.reduce((t, r) => t + Number(r.balance), 0),
                  staked: open.reduce((t, r) => t + Number(r.staked), 0), moves: [moves.n, moves.a, moves.sd] };
  facts.digest = crypto.createHash("sha256").update(JSON.stringify(facts), "utf8").digest("hex");
  return facts;
}

/**
 * The one-off (tools/stash-rekey.js): login-keyed stashes -> account keys, keyed by `key`, ONE transaction. Checks, in the
 * same transaction: every stash's balance / stake lock / earned / name / dates, the totals, the move journal, the vault
 * book (shares per stash), every vault's NAV and share price, and the total PAT supply - each exactly equal before and
 * after, else it rolls back. apply=false runs the same and rolls back (the dry run). A key already applied answers its
 * stored result; `supplyFn` / `vaultFacts` are injectable for tests.
 */
class DryRun extends Error {}
async function rekeyAll({ key, apply = false, supplyFn = null, vaultFacts = null, backup = true } = {}) {
  await init();
  if (!/^[A-Za-z0-9_.:-]{4,80}$/.test(String(key || ""))) throw new Refuse(400, "give a --key (4-80 of A-Z a-z 0-9 _ . : -)");
  if (!(await live())) throw new Refuse(409, "the stashes aren't on the site (not imported) - nothing to re-key", "E_NOT_LIVE");
  const done = await meta(`rekey:${key}`);
  if (done) return Object.assign({}, done, { already: true });
  const supply = supplyFn || (async () => (await require("./supply").patSupply()).total);
  const vfacts = vaultFacts || defaultVaultFacts;
  const bk = apply && backup ? await backupDb("pre-stash-rekey") : null;
  let result = null;
  try {
    await tx(async () => {
      const before = { money: await moneyFacts(), vaults: await vfacts(), supply: await supply(),
                       holders: await getQuery("SELECT (SELECT COUNT(*) FROM stashes) AS s, (SELECT COUNT(*) FROM stash_members) AS m") };
      const changes = await rekeyInTx();
      const after = { money: await moneyFacts(), vaults: await vfacts(), supply: await supply() };
      const checks = {
        stashes: before.money.digest === after.money.digest,
        vault_book: JSON.stringify(before.vaults) === JSON.stringify(after.vaults),
        supply: before.supply === after.supply,
      };
      result = { ok: Object.values(checks).every(Boolean), key, apply, checks, changes,
                 totals: { count: after.money.count, open: after.money.open, total: after.money.total, staked: after.money.staked,
                           supply: after.supply, digest: after.money.digest },
                 vaults: after.vaults, backup: bk };
      if (!result.ok) throw new Refuse(500, `the re-key didn't verify (${Object.keys(checks).filter((k) => !checks[k]).join(", ")}) - rolled back`, "E_VERIFY");
      if (!apply) throw new DryRun("dry run");
      await setMeta(`rekey:${key}`, Object.assign({}, result, { at: now() }));
      await setMeta("acct_keyed", { at: now(), key });
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  if (apply && result) console.log(`[stashes] re-keyed to accounts (${key}): ${result.changes.owners.length} owner(s), ${result.changes.members.length} member row(s), ${result.changes.kept.length} kept; totals unchanged`);
  return result;
}
/** The vault book and every NAV / share price, read in the open transaction (capital/vaults.js; {} without it). */
async function defaultVaultFacts() {
  let V;
  try { V = require("./capital/vaults"); } catch (e) { return {}; }
  const d = await V.load();
  if (!d || !d.inited) return { inited: false };
  const k = await V.ctx();
  const p = V.prices(d, k);
  const nav = {};
  for (const v of V.VAULTS) nav[v] = V.nav(v, k);
  return { book: crypto.createHash("sha256").update(JSON.stringify({ v: d.v, auto: d.auto, queue: d.queue }), "utf8").digest("hex"),
           nav, prices: p, auto_nav: Number(d.auto.total) * p[V.AUTO] };
}

/** An account just linked `login` (loginrekey.changed, in its transaction): stash rows held by that bare login (no account
 *  had it) and rows held by its OLD login become the account's. -> [{table, action, key, from, to}] */
async function claimLogin({ userId, oldLogin = null, newLogin = null } = {}) {
  if (!userId) return [];
  const log = [];
  const to = acctKey(userId);
  for (const l of [low(oldLogin), low(newLogin)].filter((x) => x && !isAcctKey(x))) {
    for (const r of await getQuery("SELECT id FROM stashes WHERE lower(owner) = ?", [l])) {
      await runQuery("UPDATE stashes SET owner = ?, updated = ? WHERE id = ?", [to, now(), r.id]);
      log.push({ table: "stashes", action: "owner", key: String(r.id), from: l, to });
    }
    for (const r of await getQuery("SELECT stash_id FROM stash_members WHERE lower(login) = ?", [l])) {
      const own = (await getQuery("SELECT owner FROM stashes WHERE id = ?", [r.stash_id]))[0];
      if (!own || own.owner !== to) await runQuery("INSERT OR IGNORE INTO stash_members (stash_id, login) VALUES (?, ?)", [r.stash_id, to]);
      await runQuery("DELETE FROM stash_members WHERE stash_id = ? AND lower(login) = ?", [r.stash_id, l]);
      log.push({ table: "stash_members", action: "member", key: String(r.stash_id), from: l, to });
    }
  }
  if (log.length) await bumpRevQuiet();
  return log;
}

/** accountMerge (moveUserRows, in its transaction): the merged-away account's stashes / memberships become the target's. */
async function mergeAccounts(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return { owners: 0, members: 0 };
  const hasT = async (t) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
  if (!(await hasT("stashes"))) return { owners: 0, members: 0 };
  const from = acctKey(fromId), to = acctKey(toId);
  const o = await runQuery("UPDATE stashes SET owner = ?, updated = ? WHERE owner = ?", [to, now(), from]);
  let m = 0;
  if (await hasT("stash_members")) {
    for (const r of await getQuery("SELECT stash_id FROM stash_members WHERE login = ?", [from])) {
      const own = (await getQuery("SELECT owner FROM stashes WHERE id = ?", [r.stash_id]))[0];
      if (!own || own.owner !== to) await runQuery("INSERT OR IGNORE INTO stash_members (stash_id, login) VALUES (?, ?)", [r.stash_id, to]);
      await runQuery("DELETE FROM stash_members WHERE stash_id = ? AND login = ?", [r.stash_id, from]);
      m++;
    }
    // the target may now be listed as a member of a stash it owns
    await runQuery("DELETE FROM stash_members WHERE login = ? AND stash_id IN (SELECT id FROM stashes WHERE owner = ?)", [to, to]);
  }
  const owners = (o && o.changes) || 0;
  if (owners || m) await bumpRevQuiet();
  return { owners, members: m };
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
  // 1.99wy: the signed-in ACCOUNT acts - no chat login needed (stashes belong to accounts)
  const me = await actorOf({ userId });
  if (!me.userId) return "Couldn't find your account.";
  const key = (op) => `web:${userId}:${op}:${/^[A-Za-z0-9_-]{8,64}$/.test(String(idem || "")) ? idem : crypto.randomBytes(9).toString("hex")}`;
  try {
    if (sub === "create" || sub === "new" || sub === "open") {
      const r = await create({ actor: me, name: words[1] });
      return `🔐 Stash '${r.stash.name}' created. Deposit into it below; grant someone access to share it.`;
    }
    if (["deposit", "in", "put", "store"].includes(sub)) {
      const s = await find(me, words[1]);
      const amt = parseAmount(words[2]);
      if (!amt) return `Move at least ${fmt(MIN_MOVE)} PAT.`;
      const r = await deposit({ stashId: s.id, login: me.login || acctKey(userId), userId, amount: amt, key: key("deposit") });
      return r.dup ? "Already done - that deposit went through once." : `🔐 Deposited ${fmt(r.amount)} PAT into ${r.ref} - balance ${fmt(r.balance)} PAT.`;
    }
    if (["withdraw", "out", "take"].includes(sub)) {
      const s = await find(me, words[1]);
      const raw = low(words[2]) === "all" ? "all" : parseAmount(words[2]);
      if (!raw) return `Move at least ${fmt(MIN_MOVE)} PAT.`;
      const r = await withdraw({ stashId: s.id, login: me.login || acctKey(userId), userId, amount: raw, key: key("withdraw") });
      return r.dup ? "Already done - that withdrawal went through once." : `🔐 Withdrew ${fmt(r.amount)} PAT from ${r.ref} to your wallet. Left: ${fmt(r.balance)} PAT.`;
    }
    if (["grant", "share", "allow", "add", "revoke", "remove", "unshare", "kick"].includes(sub)) {
      const add = ["grant", "share", "allow", "add"].includes(sub);
      const s = await find(me, words[1], { ownerOnly: true });
      const r = await setMembers({ stashId: s.id, who: words[2], add });
      return `🔐 ${r.who} ${add ? "can now use" : "no longer has access to"} ${s.owner_name}/${s.name}.`;
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
    return mine.slice(0, 6).map((s) => `🔐 ${s.owner_name}/${s.name}: ${fmt(s.balance)} PAT`).join(" · ");
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
    try {
      const out = await fn(b);
      // PO-0b: a refusal recorded under its key comes back as an answer (it must commit) - with the status code it always had
      if (out && out.ok === false && Number.isInteger(out.status) && out.status >= 400 && out.status < 500) return res.status(out.status).json(out);
      res.json(out);
    } catch (e) {
      if (e instanceof Refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      console.error("[stashes] bot:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  // POST so the staging router falls back to Pepe's sandbox when the staging site is down
  app.post("/api/stash/bot/status", bot(async () => ({ ok: true, enabled: await enabled(), live: await live(),
                                                       imported: await meta("imported"), rev: (await meta("rev")) || 0 })));
  app.post("/api/stash/bot/import", bot((b) => importFromPepe(b)));
  // 1.99ns: read-only export of everything the site holds for stashes (the way back / v2 genesis): every stash with its
  // members, the totals and a sha256 of the canonical list
  app.post("/api/stash/admin/export", bot(async () => {
    const all = await list({ all: true });
    const text = JSON.stringify(all);
    const open = all.filter((x) => !x.closed);
    return { ok: true, live: await live(), stashes: all, count: all.length, total: open.reduce((t, x) => t + x.balance, 0),
             staked: open.reduce((t, x) => t + x.staked, 0), seq: (await meta("seq")) || 0,
             digest: crypto.createHash("sha256").update(text, "utf8").digest("hex") };
  }));
  app.post("/api/stash/bot/state", bot(async (b) => {
    const rev = (await meta("rev")) || 0;
    if (b.since_rev !== undefined && Number(b.since_rev) === rev) return { ok: true, live: await live(), rev, same: true };
    return { ok: true, live: await live(), rev, stashes: await list({ all: true }), seq: (await meta("seq")) || 0 };
  }));
  app.post("/api/stash/bot/act", bot(async (b) => {
    const op = String(b.op || "");
    const login = String(b.login || "").trim();
    if (op === "move") return botMove({ stashId: b.stash, amount: b.amount, stakedDelta: b.staked_delta, earned: b.earned, key: b.key, kind: b.kind, why: b.why });
    if (op === "move_status") {   // 1.99adl: committed, in order; PO-0b: + state paid | refused | unknown
      const result = await settledMoveStatus(b.key);
      return { ok: true, result, state: stateOf(result) };
    }
    // 1.99wy: a chat command acts as the ACCOUNT: the one Pepe resolved for the nick (user_id / userId / username - the
    // account he charges), else the account the login is linked to (resolveRecord through the link). Access is checked
    // here by account: owner for owner-only ops, owner or member for money moves.
    const sentId = b.user_id || b.userId || null;
    const uid = sentId ? await require("./usernames").resolveUserId(sentId)            // 1.99tc: the stable id first, old names resolve
      : b.username ? ((await require("./usernames").findUser(b.username, { cols: "userId" })) || {}).userId || null : null;
    const actor = uid ? await actorOf({ userId: uid }) : await actorOf({ login });
    if (op === "create") return create({ actor, name: b.name, by: "pepe" });
    if (!["members", "rename", "close", "deposit", "withdraw"].includes(op)) throw new Refuse(400, "unknown op");
    const s = await get(b.stash);
    if (!s || s.closed) throw new Refuse(404, "That stash doesn't exist (or is closed).");
    const ownerOp = ["members", "rename", "close"].includes(op);
    if (ownerOp ? !isOwner(s, actor) : !canUse(s, actor)) {
      throw new Refuse(403, ownerOp ? "Only the stash's owner can do that." : "You don't have access to that stash.", "E_NO_ACCESS");
    }
    if (op === "members") return setMembers({ stashId: b.stash, who: b.who, add: !!b.add });
    if (op === "rename") return rename({ stashId: b.stash, name: b.name });
    if (!actor.userId) throw new Refuse(404, "couldn't find a PAT account", "E_TARGET_NOT_FOUND");
    const lg = low(login) || actor.login || acctKey(actor.userId);
    if (op === "deposit") return deposit({ stashId: b.stash, login: lg, userId: actor.userId, amount: b.amount, key: b.key, via: "chat" });
    if (op === "withdraw") return withdraw({ stashId: b.stash, login: lg, userId: actor.userId, amount: b.amount, key: b.key, via: "chat" });
    return close({ stashId: b.stash, ownerUserId: actor.userId, key: b.key, via: "chat", unstake: !!b.unstake });
  }));
  // admins: switch the backend on/off before the import (after it, the site owns the stashes for good)
  app.post("/api/admin/stash-backend", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, "econ.backend_cutover")) return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    // PO-0b (D-6): a backend switch is a Pepe OWNER's (class + the owner role on the linked chat login, read fresh); the VPS CLI
    // (tools/*-backend.js) stays the emergency path
    {
      const SR = require("./staffroles");
      if (!(await SR.ownerOf(req.user, "econ.backend_cutover"))) return res.status(403).json({ ok: false, code: "owner_only", error: SR.OWNER_ONLY });
    }
    await init();
    if (await live()) return res.status(409).json({ ok: false, error: "Already imported - the site owns the stashes now." });
    await setMeta("enabled", !!(req.body || {}).on);
    await require("./backends").noteLegacy(req.user, "stashes", !!(req.body || {}).on);   // owner answers 2026-10-20: the wish + audit (backends.js)
    res.json({ ok: true, enabled: await enabled() });
  });
}

module.exports = { init, register, enabled, live, list, get, find, total, deposit, withdraw, botMove, moveStatus, settledMoveStatus, stateOf, create, setMembers,
                   rename, close, importFromPepe, fromForm, parseAmount, canUse, isOwner, free, userIdFor, Refuse, MIN_MOVE, MAX_OWNED,
                   // 1.99wy: account keys
                   actorOf, holderInfo, holderFor, acctKey, uidOfKey, isAcctKey, targetKey, rekeyInTx, rekeyAll, moneyFacts, claimLogin,
                   mergeAccounts };
