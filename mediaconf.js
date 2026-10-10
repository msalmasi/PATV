// mediaconf.js — 1.99ji: settings for the Plex / media integrations, shared by
//   medialib.js       📼 Play from library: a movie / episode from the homelab Plex library on a pad's stage
//                     (through the media-control service, deploy/mediactl)
//   mediarequests.js  🎬 Request a movie / show: Overseerr (Seerr / Jellyseerr) requests from PATV, optionally for PAT
//   mediainvites.js   🎟️ Plex access from the store: a one-time Wizarr invite per purchase
//
// Every feature is OFF until BOTH its keys are in the environment (.env, filled by the server's admin) AND an admin
// switches it on at /admin/media. The keys never leave the server: not in a page, a log line or a response.
//
//   media_settings   key -> JSON value (only keys of DEFAULTS are read)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

// The prod store's existing items (prizes.prizeId - public ids, like shop.js ROLE_PRIZES). Admin-editable.
const DEFAULT_INVITE_ITEMS = {
  "1c120384-c080-4186-b246-f1227e82ab01": { days: 30 },    // Plex Invite 1 Month Access
  "a50a2e71-bd6b-467b-ae44-75ae59900637": { days: 365 },   // Plex Invite 1 Year Access
  "e101bcff-cc8c-4db9-b4ca-302ef5e16871": { days: 0 },     // Plex Invite Lifetime Access (0 = no expiry)
};
const DEFAULT_CREDIT_ITEMS = {
  "ff93ad3b-dde3-40c0-a4a7-7bdf9ab7de59": { kind: "movie", n: 10 },   // 10 Additional Movie Requests
  "2aa7a33a-265f-4fa3-98ea-eabad5949a2d": { kind: "tv", n: 2 },       // 2 Additional TV Requests
};

const DEFAULTS = {
  // 📼 library playback
  library_enabled: false,
  library_allow: "admins",        // admins (class Admin) | staff (Admin + Staff). Later: approved pads.
  library_quality: 720,           // the default pick: 1080 | 720 | 480
  library_pause_max_min: 30,      // a paused library slot ends after this long
  // 🎬 requests (Overseerr)
  requests_enabled: false,
  request_price_movie: 0,         // PAT per movie request (0 = free); request credits are used first
  request_price_tv: 0,            // PAT per show request
  requests_per_day: 3,            // per PATV account
  request_min_level: 0,
  overseerr_service_user: "",     // Overseerr user id that unmatched PATV accounts request as ("" = the API key's owner)
  request_poll_min: 10,           // how often open requests are re-checked (the webhook makes it instant)
  credit_items: DEFAULT_CREDIT_ITEMS,
  // 🎟️ invites (Wizarr)
  invites_enabled: false,
  wizarr_server_ids: "",          // comma-separated Wizarr server ids ("" = Wizarr's default)
  wizarr_library_ids: "",         // comma-separated library ids ("" = every library)
  wizarr_link_days: 7,            // how long the invite LINK works (1 | 7 | 30); the access length comes from the item
  invite_items: DEFAULT_INVITE_ITEMS,
};

const env = (k) => String(process.env[k] || "").trim();
/** Which integrations have their keys in the environment (names only, never values). */
function keys() {
  return {
    mediactl: !!(env("MEDIACTL_URL") && env("MEDIACTL_SECRET").length >= 32),
    mediactl_tls_pinned: !!env("MEDIACTL_TLS_SHA256"),
    overseerr: !!(env("OVERSEERR_URL") && env("OVERSEERR_API_KEY")),
    overseerr_webhook: !!env("OVERSEERR_WEBHOOK_SECRET"),
    wizarr: !!(env("WIZARR_URL") && env("WIZARR_API_KEY")),
  };
}

const S = JSON.parse(JSON.stringify(DEFAULTS));
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS media_settings (key TEXT PRIMARY KEY, value TEXT)");
      for (const r of await getQuery("SELECT key, value FROM media_settings")) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, r.key)) continue;
        try { S[r.key] = JSON.parse(r.value); } catch (e) { /* keep the default */ }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const get = () => JSON.parse(JSON.stringify(S));

const num = (v, lo, hi, d) => { const n = Math.floor(Number(String(v == null ? "" : v).replace(/[, _]/g, ""))); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const bool = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
const ids = (v) => String(v == null ? "" : v).split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s)).join(",");
// {prizeId: {...}} maps from the admin form's JSON text; bad rows are dropped
function itemMap(v, shape) {
  let o = v;
  if (typeof v === "string") { try { o = v.trim() ? JSON.parse(v) : {}; } catch (e) { throw Object.assign(new Error("That item list isn't valid JSON."), { status: 400, refuse: true }); } }
  const out = {};
  for (const [k, x] of Object.entries(o || {})) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(k) || !x || typeof x !== "object") continue;
    const r = shape(x);
    if (r) out[k] = r;
  }
  return out;
}
const CLEAN = {
  library_enabled: bool, requests_enabled: bool, invites_enabled: bool,
  library_allow: (v) => (["admins", "staff"].includes(v) ? v : "admins"),
  library_quality: (v) => ([1080, 720, 480].includes(Number(v)) ? Number(v) : 720),
  library_pause_max_min: (v) => num(v, 5, 240, 30),
  request_price_movie: (v) => num(v, 0, 100000000, 0),
  request_price_tv: (v) => num(v, 0, 100000000, 0),
  requests_per_day: (v) => num(v, 0, 100, 3),
  request_min_level: (v) => num(v, 0, 1000, 0),
  overseerr_service_user: (v) => (/^\d{1,9}$/.test(String(v || "").trim()) ? String(v).trim() : ""),
  request_poll_min: (v) => num(v, 2, 240, 10),
  credit_items: (v) => itemMap(v, (x) => (["movie", "tv"].includes(x.kind) && num(x.n, 1, 1000, 0) ? { kind: x.kind, n: num(x.n, 1, 1000, 1) } : null)),
  wizarr_server_ids: ids, wizarr_library_ids: ids,
  wizarr_link_days: (v) => ([1, 7, 30].includes(Number(v)) ? Number(v) : 7),
  invite_items: (v) => itemMap(v, (x) => ({ days: num(x.days, 0, 3650, 30) })),
};
/** Save a patch (unknown keys ignored). Checkboxes: pass `_bools` (a list of the form's checkbox names) so unticked = false. */
async function set(patch, actor) {
  await init();
  const p = { ...(patch || {}) };
  for (const b of [].concat(p._bools || [])) if (!(b in p) && CLEAN[b] === bool) p[b] = false;
  const changed = [];
  for (const [k, v] of Object.entries(p)) {
    if (!Object.prototype.hasOwnProperty.call(CLEAN, k)) continue;
    const val = CLEAN[k](v);
    if (JSON.stringify(val) === JSON.stringify(S[k])) continue;
    S[k] = val;
    await runQuery("INSERT INTO media_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(val)]);
    changed.push(k);
  }
  if (changed.length) console.log(`[media] settings changed by ${actor || "?"}: ${changed.join(", ")}`);
  return { settings: get(), changed };
}

const isAdmin = (u) => !!u && u.class === "Admin";
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");
/** May this account use 📼 Play from library? (the setting + its class) */
const libraryAllowed = (u) => (S.library_allow === "staff" ? isStaff(u) : isAdmin(u));
const on = {
  library: () => !!S.library_enabled && keys().mediactl,
  requests: () => !!S.requests_enabled && keys().overseerr,
  invites: () => !!S.invites_enabled && keys().wizarr,
};

/** A short, log-safe line for an upstream error: never echoes URLs with credentials or response bodies. */
function errLine(e) {
  return String((e && (e.publicMessage || e.message)) || e || "error").replace(/https?:\/\/\S+/g, "<url>").replace(/[A-Za-z0-9]{24,}/g, "…").slice(0, 200);
}

module.exports = { init, get, set, keys, on, libraryAllowed, isAdmin, isStaff, errLine, DEFAULTS, DEFAULT_INVITE_ITEMS, DEFAULT_CREDIT_ITEMS, _S: S };
