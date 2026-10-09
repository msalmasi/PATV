// backendAuth.js - 1.99fy: the PATV user lookups (/api/users/discord/:id ...) are bot-only now. This adds
// the bot token, as an X-Bot-Token header, to this process's axios calls to BACKEND_BASE_URL/api/users/
// - nowhere else. Loaded by userUtils.js, so the Discord bot AND blackjack (which runs from its own
// folder, whose .env has no token) both get it.
const axios = require("axios");
const fs = require("fs");
const path = require("path");

let cached;
function token() {
  if (cached !== undefined) return cached;
  cached = process.env.DISCORD_BOT_TOKEN || null;
  if (!cached) {
    // blackjack's cwd is ../blackjack: read the token from this bot's own .env (value never logged)
    try {
      const m = /^\s*DISCORD_BOT_TOKEN\s*=\s*(.*?)\s*$/m.exec(fs.readFileSync(path.join(__dirname, ".env"), "utf8"));
      if (m && m[1]) cached = m[1].replace(/^(['"])(.*)\1$/, "$2");
    } catch (e) { /* no .env next to the bot */ }
  }
  if (!cached) console.error("[backendAuth] no DISCORD_BOT_TOKEN - PATV user lookups will be refused");
  return cached;
}

function isLookup(url) {
  const base = String(process.env.BACKEND_BASE_URL || "").replace(/\/+$/, "");
  return !!base && String(url || "").startsWith(base + "/api/users/");
}

if (!axios.__patvBotAuth) {
  axios.__patvBotAuth = true;
  axios.interceptors.request.use((cfg) => {
    if (isLookup(cfg.url)) {
      const t = token();
      if (t) {
        if (cfg.headers && typeof cfg.headers.set === "function") cfg.headers.set("X-Bot-Token", t);
        else cfg.headers = Object.assign({}, cfg.headers, { "X-Bot-Token": t });
      }
    }
    return cfg;
  });
}

module.exports = { token, isLookup };
