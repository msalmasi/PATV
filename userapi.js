// userapi.js (1.99ade) - two of the old /api/u/:username reads, moved out of index.js unchanged except for what they give away:
//
//   GET /api/u/:username/profile        username, class, displayname, avatar - no points_balance any more: its callers (the
//                                       nav avatar in layout.ejs, activeGames.ejs) only read the avatar, and a member can
//                                       hide their balance from visitors (profilelayout "stats_balance"). Bots read balances
//                                       from /api/u/:username/balance.
//   GET /api/u/:username/transactions   a member's PAT history (type, points, timestamp; ?limit= up to 50), by username or
//                                       Camfrog login. PAT history is private everywhere else (the profile's canSeeHistory,
//                                       /history), but this answered anyone - and any web page, CORS is open. Now: the account
//                                       itself, history.lookup (Admin / Staff), or a bot caller (isBotToken: Pepe's !history
//                                       sends his X-PATV-Key, botkeys.js; the shared token in an X-Bot-Token header counts
//                                       too). Anyone else gets exactly the "no such user" answer, so names can't be probed.
"use strict";
const { getQuery } = require("./dbUtils");
const SP = require("./siteperms");

function register(app, { addUser, isBotToken }) {
  app.get("/api/u/:username/profile", async (req, res) => {
    try {
      const rows = await getQuery("SELECT username, class, displayname, avatar FROM users WHERE username = ?", [req.params.username]);
      if (rows.length > 0) return res.json(rows[0]);
      res.status(404).send("User not found.");
    } catch (error) {
      console.error("Failed to retrieve user data:", error);
      res.status(500).send("Failed to retrieve user data.");
    }
  });

  app.get("/api/u/:username/transactions", addUser, async (req, res) => {
    const { username } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    res.set("Cache-Control", "private, no-store");
    try {
      // the account: by username or camfrogUsername (case-insensitive)
      const userRows = await getQuery("SELECT userId FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(camfrogUsername) = LOWER(?)",
                                      [username, username]);
      const me = req.user && req.user.userId ? String(req.user.userId) : null;
      const allowed = userRows.length > 0 && (isBotToken(req.get("x-bot-token") || undefined)
        || (!!me && me === String(userRows[0].userId)) || (!!me && SP.can(req.user, "history.lookup")));
      if (!allowed) return res.status(404).json({ error: "User not found" });
      const transactions = await getQuery("SELECT type, points, timestamp FROM transactions WHERE userId = ? ORDER BY timestamp DESC LIMIT ?",
                                          [userRows[0].userId, limit]);
      res.json({ transactions });
    } catch (err) {
      console.error("Transaction history error:", err);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  });
}

module.exports = { register };
