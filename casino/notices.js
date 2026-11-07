// casino/notices.js — one-time notices at the casino tables (1.99alq train3, owner answer 1, 2026-11-07: "Poker timeout rule
// ok"). Hand-off 21's Hold'em timeout rule shipped live with no switch, so for its first WINDOW_MS after the first start that
// has it, a player's first Hold'em buy-in carries a notice of it, once per account:
//   * the window: casino_settings 'notice_from:<id>' = the first boot (or first check) with the notice - written once
//     (INSERT OR IGNORE), so a restart or a deploy never moves it;
//   * once: casino_notice_seen (userId, notice) - an INSERT OR IGNORE that inserted a row is the one time it shows;
//   * the words follow casino/holdem.js: ACT_SECS (60 s), then the seat's time bank, then check - or fold with a bet to call;
//     two timeouts with no action between sit the seat out; hm_sitout_mins (default 10, /admin/games) sitting out cashes it
//     out. test/casino-hm-notice.test.js plays each claim.
// The website shows `notice` on the table page (casinohm.js, translated: js.casino.rule_timeout - the same English); Pepe PMs
// a Camfrog player the reply (holdem.js sit).
"use strict";
const { runQuery, getQuery } = require("../dbUtils");

const WINDOW_MS = 7 * 24 * 3600 * 1000;

const NOTICES = {
  hm_timeout: (settings) => {
    const n = Number(settings && settings.hm_sitout_mins);
    const mins = Number.isInteger(n) && n >= 1 ? n : 10;
    return { id: "hm_timeout", mins,
      text: "🆕 New rule: if your timer and time bank run out you check (or fold if you can't check). Two timeouts in a row sit " +
            `you out. Sitting out for ${mins} minute${mins === 1 ? "" : "s"} cashes you out.` };
  },
};

let readyP = null;
function ensure() {
  if (!readyP) {
    readyP = runQuery(`CREATE TABLE IF NOT EXISTS casino_notice_seen (userId TEXT NOT NULL, notice TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (userId, notice))`).catch((e) => { readyP = null; throw e; });
  }
  return readyP;
}

/** The window's start for notice `id` (stamped at `now` the first time). */
async function since(id, now) {
  await runQuery(`INSERT OR IGNORE INTO casino_settings (key, value, updated, actor) VALUES (?, ?, ?, 'casino')`,
                 ["notice_from:" + id, String(now), now]);
  const r = await getQuery("SELECT value FROM casino_settings WHERE key = ?", ["notice_from:" + id]);
  const v = Number(r[0] && r[0].value);
  return Number.isFinite(v) ? v : now;
}

/** At boot: start the windows (casino/service.js ensure()). */
async function stamp(now) {
  await ensure();
  for (const id of Object.keys(NOTICES)) await since(id, now);
}

/** {id, mins, text} the ONE time `uid` should see notice `id` (inside its window), else null. Never throws. */
async function take(id, uid, now, settings) {
  try {
    if (!NOTICES[id] || !uid) return null;
    await ensure();
    if (now >= (await since(id, now)) + WINDOW_MS) return null;
    const r = await runQuery("INSERT OR IGNORE INTO casino_notice_seen (userId, notice, at) VALUES (?, ?, ?)", [String(uid), id, now]);
    return r && r.changes === 1 ? NOTICES[id](settings) : null;
  } catch (e) {
    console.error("[casino] notice:", e && e.message ? e.message : e);
    return null;
  }
}

module.exports = { take, stamp, ensure, NOTICES, WINDOW_MS };
