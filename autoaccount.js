// autoaccount.js — what a Camfrog "auto account" is (docs/auto-account-escrow.md). The one helper.
//
// Pepe makes a PATV account the first time he needs one for a Camfrog login that has none (find_or_create_user ->
// POST /api/users/camfrog/register): username "CF" + 8 random [a-z0-9], a random email without "@", a random password.
// Before this file the test was copied around as two different regexes (/^CF[a-z0-9]{8}$/ and /^cf[a-z0-9]{8}$/i) and an
// SQL GLOB in ~13 places.
//
//   AUTO_NAME    the generator's USERNAME, case-sensitive ("CFab12cd34")
//   AUTO_LOGIN   a Camfrog LOGIN / display text that looks like one, any case (a login that IS an auto name)
//   AUTO_GLOB    AUTO_NAME as an SQLite GLOB
//   users.auto_source  provenance, never cleared: 'camfrog' for an account Pepe made (set at register; backfilled
//                      once for rows whose username matches AUTO_NAME and whose email has no "@")
//
// isAutoAccount(): an account is an auto account RIGHT NOW when it was made by Pepe (auto_source, still an AUTO_NAME
// username) and nobody can sign in to it: no email with "@", no Discord / Twitch id, no sso_links (Google / Plex /
// Telegram sign-in), no telegram_links, no plex_members link. Computed, not a flag - no sign-in path can forget to
// clear it.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const AUTO_NAME = /^CF[a-z0-9]{8}$/;
const AUTO_LOGIN = /^cf[a-z0-9]{8}$/i;
const AUTO_GLOB = "CF[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]";
const SOURCE_CAMFROG = "camfrog";

/** A username the generator made (exact case), or with {anyCase: true} any text shaped like one (a login). */
function isAutoName(name, { anyCase = false } = {}) {
  return (anyCase ? AUTO_LOGIN : AUTO_NAME).test(String(name || ""));
}

let readyP = null;
/** users.auto_source + the one-time backfill. Safe to call often. */
function ensure() {
  if (readyP) return readyP;
  readyP = (async () => {
    const cols = (await getQuery("SELECT name FROM pragma_table_info('users')")).map((r) => r.name);
    if (!cols.length) { readyP = null; return false; }          // no users table yet (tests / first boot)
    if (!cols.includes("auto_source")) {
      try { await runQuery("ALTER TABLE users ADD COLUMN auto_source TEXT"); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      // the backfill: Pepe's accounts are the AUTO_NAME usernames with the generator's "@"-less random email
      const r = await runQuery(`UPDATE users SET auto_source = ? WHERE auto_source IS NULL AND username GLOB '${AUTO_GLOB}'
                                AND (email IS NULL OR email NOT LIKE '%@%')`, [SOURCE_CAMFROG]);
      console.log(`[autoaccount] users.auto_source added; ${(r && r.changes) || 0} auto account(s) marked`);
    }
    return true;
  })().catch((e) => { readyP = null; console.error("[autoaccount] setup:", e.message); return false; });
  return readyP;
}

const tableCache = new Map();
async function hasTable(name) {
  if (tableCache.get(name)) return true;
  const ok = (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name])).length > 0;
  if (ok) tableCache.set(name, true);          // only "exists" is cached: a table made later is seen next time
  return ok;
}

/** The facts of one users row (no links looked up): {made, signIn} */
function rowFacts(u) {
  if (!u) return { made: false, signIn: false };
  const made = !!u.auto_source && AUTO_NAME.test(String(u.username || ""));
  const email = String(u.email || "");
  const signIn = email.includes("@") || !!String(u.discordId || "").trim() || !!String(u.twitchId || "").trim();
  return { made, signIn };
}

/** Does any linked sign-in method (SSO, Telegram, Plex) point at this account? */
async function hasLinkedSignIn(userId) {
  const id = String(userId);
  for (const [t, col] of [["sso_links", "user_id"], ["telegram_links", "user_id"], ["plex_members", "user_id"]]) {
    if (!(await hasTable(t))) continue;
    if ((await getQuery(`SELECT 1 FROM ${t} WHERE ${col} = ? LIMIT 1`, [id])).length) return true;
  }
  return false;
}

/** Is this account an auto account right now (made by Pepe, nobody can sign in to it)? false for a missing account. */
async function isAutoAccount(userId) {
  if (!userId) return false;
  await ensure();
  const u = (await getQuery("SELECT username, email, discordId, twitchId, auto_source FROM users WHERE userId = ?", [String(userId)]))[0];
  const f = rowFacts(u);
  if (!f.made || f.signIn) return false;
  return !(await hasLinkedSignIn(userId));
}

/** Mark an account Pepe just made (the register route). Never throws. */
async function markNew(userId, source = SOURCE_CAMFROG) {
  try {
    await ensure();
    await runQuery("UPDATE users SET auto_source = ? WHERE userId = ? AND auto_source IS NULL", [String(source).slice(0, 20), String(userId)]);
  } catch (e) { console.error("[autoaccount] mark:", e.message); }
}

module.exports = { AUTO_NAME, AUTO_LOGIN, AUTO_GLOB, SOURCE_CAMFROG, isAutoName, ensure, rowFacts, hasLinkedSignIn, isAutoAccount, markNew };
