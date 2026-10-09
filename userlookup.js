// userlookup.js - 1.99fy (security): the Discord / Twitch bot user lookups.
//
// GET /api/users/discord/:id, /api/users/twitch/:id and /api/users/twitch/displayname/:name used to
// be open to anyone and answered with the whole users row (SELECT *): the bcrypt password hash, the
// email, the email-verification and password-reset tokens, the balance and the other platform's id.
// The two id lookups also restored archived accounts / cleared archive notices (stale.touch) for
// any caller. Now:
//   * bot-only: the caller sends the platform bot token in an "X-Bot-Token" header (or
//     "Authorization: Bearer <token>") - 401 without one, 403 with a wrong one. Never in the URL
//     (query strings end up in access logs).
//   * only LOOKUP_FIELDS go back - what the Discord bot, the Discord selfbot, blackjack, the Twitch
//     bot (server.js) and Pepe actually read: userId, username, displayname, points_balance,
//     discordId / discordUsername, twitchId / twitchDisplayname / twitchLogin.
//   * touch() (restore an archived account, clear its notice) only runs behind that check.
//
// ensureProviderUnique(): partial unique indexes on users.twitchId / users.discordId (one PATV
// account per Twitch / Discord id). If duplicates exist the index isn't built - it logs and moves on.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const LOOKUP_FIELDS = ["userId", "username", "displayname", "points_balance", "discordId", "discordUsername",
  "twitchId", "twitchDisplayname", "twitchLogin"];

// the users columns this database has, of LOOKUP_FIELDS (twitchLogin arrived in 1.99bu)
async function lookupCols() {
  const have = new Set((await getQuery("SELECT name FROM pragma_table_info('users')")).map((r) => r.name));
  return LOOKUP_FIELDS.filter((c) => have.has(c));
}

/** The minimal lookup row for users.<col> = value, or null. col is one of our own constants. */
async function lookupRow(col, value) {
  if (!["discordId", "twitchId", "twitchDisplayname", "userId"].includes(col)) throw new Error("bad lookup column");
  const cols = await lookupCols();
  const row = (await getQuery(`SELECT ${cols.join(", ")} FROM users WHERE ${col} = ? LIMIT 1`, [String(value)]))[0];
  return row ? minimal(row) : null;
}

/** Only LOOKUP_FIELDS, whatever the row had. */
function minimal(row) {
  const out = {};
  for (const k of LOOKUP_FIELDS) if (row && Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
  return out;
}

/** The bot token a request carries (header only), or null. */
function botTokenOf(req) {
  const h = req.get("x-bot-token");
  if (h) return String(h);
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get("authorization") || "");
  return m ? m[1] : null;
}

/** Express middleware: 401 without a token, 403 with a wrong one. */
function requireBot(isPlatformBot) {
  return (req, res, next) => {
    const t = botTokenOf(req);
    if (!t) return res.status(401).json({ error: "unauthorized" });
    if (!isPlatformBot(t)) return res.status(403).json({ error: "forbidden" });
    next();
  };
}

function register(app, { isPlatformBot, stale }) {
  const bot = requireBot(isPlatformBot);

  // by Discord / Twitch id: a bot seeing the person again brings an archived account back (1.99bm)
  const byId = (col, via) => async (req, res) => {
    const id = String(req.params.id || "");
    try {
      let user = await lookupRow(col, id);
      if (!user) return res.status(404).json({ message: "User not found" });
      if (stale && (await stale.touch(user.userId, via))) user = (await lookupRow(col, id)) || user;
      res.json({ user });
    } catch (e) {
      console.error(`[users] ${via} lookup:`, e.message);
      res.status(500).json({ error: "Failed to retrieve user" });
    }
  };
  app.get("/api/users/discord/:id", bot, byId("discordId", "discord"));
  app.get("/api/users/twitch/:id", bot, byId("twitchId", "twitch"));

  // by Twitch display name (tips / channel points by @name): a name, not an identity - no touch
  app.get("/api/users/twitch/displayname/:name", bot, async (req, res) => {
    try {
      const user = await lookupRow("twitchDisplayname", String(req.params.name || ""));
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json({ user });
    } catch (e) {
      console.error("[users] twitch display name lookup:", e.message);
      res.status(500).json({ message: "Failed to retrieve user" });
    }
  });
}

/** One PATV account per Twitch id and per Discord id. Returns {twitchId: bool, discordId: bool}. */
async function ensureProviderUnique() {
  const out = {};
  for (const [name, col] of [["users_twitch_id", "twitchId"], ["users_discord_id", "discordId"]]) {
    try {
      await runQuery(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON users (${col}) WHERE ${col} IS NOT NULL AND ${col} != ''`);
      out[col] = true;
    } catch (e) {
      let n = "?";
      try {
        n = (await getQuery(`SELECT COUNT(*) AS n FROM (SELECT ${col} FROM users WHERE ${col} IS NOT NULL AND ${col} != ''
                             GROUP BY ${col} HAVING COUNT(*) > 1)`))[0].n;
      } catch (_) { /* table missing */ }
      console.error(`[accounts] unique ${col} index not built (${e.message}); ${n} duplicated id(s)`);
      out[col] = false;
    }
  }
  return out;
}

module.exports = { LOOKUP_FIELDS, lookupRow, minimal, botTokenOf, requireBot, register, ensureProviderUnique };
