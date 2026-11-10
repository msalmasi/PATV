// pepelogins.js — 1.99?? (Pepe account rotation): the ONE list of Pepe's Camfrog logins on the site.
//
// Pepe's Camfrog account can be rotated (the owner signs him into a new account and moves his home room: houserotate.js). Code
// that has to recognise him by his Camfrog login - "never a streak / a launch grant / a stale-account sweep for Pepe", "a
// notice to his own login counts as sent", "a market judged by the AI" - reads this list instead of a hard-coded
// {pepefrog, pepebeta}. It is DENY-ONLY: being on it only ever keeps a login out of something (the bot's _pepe_accounts(), D3).
//
// The list (lower case) is the union of
//   - the built-in logins: pepefrog (prod until 2026-11-10), pepebeta (staging)
//   - env PEPE_LOGINS (comma separated; roomactivity.js reads it too)
//   - rooms_kv pepe_logins = {current, former: [...], at} - written by the house rotation (houserotate.js) and by Pepe's owner sync
//     (identity: {login, former_logins}; noteIdentity). Union only: a login once on it stays (deny-only), up to MAX_FORMER.
//   - the login Pepe was last seen acting as: escrow_meta / oracle_meta pepe_login (escrow/pools.js, oracle.js)
// Cached in the process; refreshed at most once a minute when read (refresh() right after a change).
//
//   list() -> Set   has(login) -> bool   current() -> the configured current login | null
//   sqlIn(extra) -> {sql: "(?, ?, ...)", params}   for "login NOT IN (...)" with placeholders
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const BUILTIN = Object.freeze(["pepefrog", "pepebeta"]);
const LOGIN_RE = /^[a-z0-9][a-z0-9_.@\-]{0,59}$/;          // a lower-cased Camfrog login (room ids like pepefrog.room fit too)
const MAX_FORMER = 20;
const REFRESH_MS = 60 * 1000;
const KV_KEY = "pepe_logins";

const clean = (v) => { const s = String(v == null ? "" : v).trim().toLowerCase(); return LOGIN_RE.test(s) ? s : null; };
const envLogins = () => String(process.env.PEPE_LOGINS || "").split(",").map(clean).filter(Boolean);
const uniq = (a) => [...new Set(a.filter(Boolean))];

let REC = { current: null, former: [], at: null };          // rooms_kv pepe_logins
let LEARNED = [];                                           // escrow_meta / oracle_meta pepe_login
let SET = build();
let AT = 0;
let refreshing = null;

function build() { return new Set([...BUILTIN, ...envLogins(), ...(REC.current ? [REC.current] : []), ...REC.former, ...LEARNED]); }

/** rooms_kv pepe_logins (a JSON string, or anything) -> {current, former, at} (cleaned). */
function parseRecord(v) {
  let r = null;
  try { r = typeof v === "string" ? JSON.parse(v) : v; } catch (e) { r = null; }
  if (!r || typeof r !== "object") return { current: null, former: [], at: null };
  const current = clean(r.current);
  const former = uniq((Array.isArray(r.former) ? r.former : []).map(clean)).filter((x) => x !== current).slice(-MAX_FORMER);
  return { current, former, at: Number(r.at) || null };
}
/** The record after Pepe says he is `current` now and was `former` before: union - the old current joins former. */
function merge(rec, { current, former } = {}) {
  const base = parseRecord(rec);
  const cur = clean(current) || base.current;
  const all = uniq([...base.former, ...(base.current && base.current !== cur ? [base.current] : []), ...(Array.isArray(former) ? former : [former]).map(clean)]);
  return { current: cur, former: all.filter((x) => x !== cur).slice(-MAX_FORMER) };
}

async function metaLogin(table) {
  try {
    const r = (await getQuery(`SELECT value FROM ${table} WHERE key = 'pepe_login'`))[0];
    if (!r) return null;
    let v = r.value;
    try { v = JSON.parse(r.value); } catch (e) { v = r.value; }
    return clean(v);
  } catch (e) { return null; }                               // no such table on this site
}
async function readRecord() {
  try {
    const r = (await getQuery("SELECT value FROM rooms_kv WHERE key = ?", [KV_KEY]))[0];
    return parseRecord(r && r.value);
  } catch (e) { return { current: null, former: [], at: null }; }
}

/** Re-read everything now (after the rotation / an owner sync changed it). -> the list */
async function refresh() {
  REC = await readRecord();
  LEARNED = uniq([await metaLogin("escrow_meta"), await metaLogin("oracle_meta")]);
  SET = build();
  AT = Date.now();
  return new Set(SET);
}
function maybeRefresh() {
  if (Date.now() - AT > REFRESH_MS && !refreshing) {
    refreshing = refresh().catch((e) => console.error("[pepelogins] refresh:", e.message)).finally(() => { refreshing = null; });
  }
}
const init = () => (AT ? Promise.resolve(new Set(SET)) : refresh());

/** Every login Pepe has (had), lower case. */
function list() { maybeRefresh(); return new Set(SET); }
/** Is this one of Pepe's logins (case-insensitive)? */
function has(login) { maybeRefresh(); const s = clean(login); return !!s && SET.has(s); }
/** The current login the rotation / owner sync recorded, or null. */
function current() { maybeRefresh(); return REC.current || null; }
/** {current, former} as recorded (a copy). */
function record() { maybeRefresh(); return { current: REC.current, former: REC.former.slice() }; }
/** "(?, ?, ...)" + params: the list (plus `extra` words) for a SQL "IN" with placeholders. */
function sqlIn(extra = []) {
  const all = uniq([...SET, ...(Array.isArray(extra) ? extra : []).map(clean)]);
  maybeRefresh();
  return { sql: "(" + all.map(() => "?").join(", ") + ")", params: all };
}

/** Write rooms_kv pepe_logins = merge(what is there, {current, former}) - in the caller's transaction when there is one. The
 *  cache follows with refresh() (after the commit). -> the record written */
async function save({ current, former } = {}, now = Date.now()) {
  await runQuery("CREATE TABLE IF NOT EXISTS rooms_kv (key TEXT PRIMARY KEY, value TEXT)");
  const r = (await getQuery("SELECT value FROM rooms_kv WHERE key = ?", [KV_KEY]))[0];
  const next = merge(r && r.value, { current, former });
  const value = JSON.stringify({ ...next, at: now });
  await runQuery("INSERT INTO rooms_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [KV_KEY, value]);
  return next;
}

/**
 * Pepe's owner sync (roomsweb.js POST /api/rooms/owners): identity = {login, former_logins}. Recorded only when it adds something
 * (a new current login or a former one the record doesn't have). Never moves the house room. -> true when it changed the record
 */
async function noteIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const login = clean(identity.login);
  const former = (Array.isArray(identity.former_logins) ? identity.former_logins : []).slice(0, MAX_FORMER).map(clean).filter(Boolean);
  if (!login && !former.length) return false;
  const now = await readRecord();
  const next = merge(now, { current: login, former });
  if (next.current === now.current && next.former.length === now.former.length && next.former.every((x) => now.former.includes(x))) return false;
  await save({ current: login, former });
  await refresh();
  console.log(`[pepelogins] Pepe's logins: current ${next.current || "-"}, former ${next.former.join(", ") || "-"} (owner sync)`);
  return true;
}

module.exports = { init, refresh, list, has, current, record, sqlIn, save, merge, parseRecord, noteIdentity, clean, BUILTIN, KV_KEY,
                   _reset: () => { REC = { current: null, former: [], at: null }; LEARNED = []; SET = build(); AT = 0; } };
