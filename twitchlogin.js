// twitchlogin.js - 1.99bu: the real Twitch login (users.twitchLogin).
//
// Twitch OAuth gives both `login` (the channel name: twitch.tv/<login>) and `display_name`. Only the
// display name used to be stored (twitchDisplayname), and the channel link was derived from it - which
// breaks for a localized display name (CJK etc.) and depends on capitals. Every Twitch sign-in now
// stores the login too; accounts that haven't signed in since keep the display-name fallback (there's no
// backfill: reading a login needs the user's token).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const TW_LOGIN = /^[a-z0-9_]{3,25}$/;

let readyP = null;
/** users.twitchLogin. Idempotent; retried until the users table exists. */
function ensure() {
  if (readyP) return readyP;
  readyP = (async () => {
    const cols = await getQuery("SELECT name FROM pragma_table_info('users')");
    if (!cols.length) { readyP = null; return false; }
    if (!cols.some((c) => c.name === "twitchLogin")) {
      try { await runQuery("ALTER TABLE users ADD COLUMN twitchLogin TEXT"); }
      catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }
    return true;
  })().catch((e) => { readyP = null; console.error("[twitchlogin] ensure:", e.message); return false; });
  return readyP;
}

/** A Twitch login as Twitch sends it (lower-case a-z 0-9 _ , 3-25), else null. */
function clean(login) {
  const l = String(login || "").trim().toLowerCase();
  return TW_LOGIN.test(l) ? l : null;
}

/** Store the login on the account(s) holding this Twitch id. Never throws. Returns rows changed. */
async function save(twitchId, login) {
  try {
    const l = clean(login);
    if (!twitchId || !l || !(await ensure())) return 0;
    const r = await runQuery("UPDATE users SET twitchLogin = ? WHERE twitchId = ? AND (twitchLogin IS NULL OR twitchLogin != ?)", [l, String(twitchId), l]);
    return (r && r.changes) || 0;
  } catch (e) { console.error("[twitchlogin] save:", e.message); return 0; }
}

module.exports = { ensure, clean, save, TW_LOGIN };
