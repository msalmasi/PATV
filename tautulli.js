// tautulli.js — 1.99nj: a read-only client for Tautulli's API (api/v2), the Plex server's watch history.
//
// Used by plexstats.js (the 📼 Plex tab on profiles: watch time, plays, genres, libraries, favourites, a streak) and
// plexpad.js (genres / collections / studio / server-wide play counts for the 📼 Plex-on-pads achievements).
//
// Config (.env, never in the repo): TAUTULLI_URL (the address the VPS reaches it on - the homelab's public
// https://tautulli.<domain>, whose /api/v2 is not behind the SSO gate, like Wizarr's /api) + TAUTULLI_API_KEY
// (Tautulli -> Settings -> Web Interface -> API key). Both missing = everything here reports "not configured" and the
// features that use it stay quiet. The key never leaves the server: not in a page, a log line or an error message.
"use strict";
const http = require("http");
const https = require("https");

const env = (k) => String(process.env[k] || "").trim();
const MAX_BYTES = 16 * 1024 * 1024;

/** Both the URL and the key are in the environment (names only - never the values). */
function configured() { return !!(impl || (env("TAUTULLI_URL") && env("TAUTULLI_API_KEY").length >= 8)); }

let impl = null;          // tests: _set(async (cmd, params) => data)

class TautulliError extends Error {
  constructor(message, status) { super(message); this.status = status || 502; }
}

/**
 * One API call -> its `data`. Throws TautulliError (a message without the URL or the key) when it isn't configured,
 * can't be reached, or answers anything but result "success".
 */
async function call(cmd, params = {}, { timeout = 20000 } = {}) {
  if (!/^[a-z_]{3,40}$/.test(String(cmd))) throw new TautulliError("bad Tautulli command", 400);
  if (impl) return impl(cmd, { ...params });
  if (!configured()) throw new TautulliError("Tautulli isn't configured", 503);
  let u;
  try { u = new URL(env("TAUTULLI_URL").replace(/\/+$/, "") + "/api/v2"); } catch (e) { throw new TautulliError("TAUTULLI_URL isn't a valid address", 503); }
  u.searchParams.set("apikey", env("TAUTULLI_API_KEY"));
  u.searchParams.set("cmd", cmd);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== "") u.searchParams.set(k, String(v));
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(u, { timeout, headers: { Accept: "application/json", "User-Agent": "PATV" } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (d) => { size += d.length; if (size > MAX_BYTES) req.destroy(new Error("answer too big")); else chunks.push(d); });
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { /* not JSON */ }
        const r = j && j.response;
        if (!r || r.result !== "success") {
          // Tautulli's own messages ("Invalid apikey", "Parameter user_id is required") never carry the key
          const why = r && r.message ? String(r.message).replace(/[A-Za-z0-9]{24,}/g, "…").slice(0, 120) : `HTTP ${res.statusCode}`;
          return reject(new TautulliError(`Tautulli ${cmd}: ${why}`, res.statusCode === 401 ? 502 : 502));
        }
        resolve(r.data);
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(new TautulliError(`Tautulli ${cmd}: can't be reached (${e.code || String(e.message || "error").replace(/https?:\/\/\S+/g, "<url>").slice(0, 60)})`)));
  });
}

module.exports = { call, configured, TautulliError, _set: (fn) => { impl = fn || null; } };
