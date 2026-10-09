// padcfg.js — the site-admin settings for pad addresses, user-made pads and platform connections (1.99iy+).
// Stored as one JSON value in rooms_kv "pads_cfg"; every value is clamped on the way in and on the way out, so a
// bad row can't break a page. Money settings (the creation fee) are the user's call: the default is 0 (free).
//
//   rename_days      an owner may change their pad's address once per this many days (site staff: any time)
//   (1.99iz) create  user-made pads: on/off, who may (linked account, account age, level), how many, the fee
//   (1.99iz) reclaim inactive empty pads go back to the pool after N days - OFF by default
"use strict";

const DEFAULTS = Object.freeze({
  rename_days: 30,
});
const LIMITS = Object.freeze({
  rename_days: [0, 365],
});

// what the admin form shows for each setting (views/partials/pads-admin-cfg.ejs draws these)
const FIELDS = Object.freeze([
  { key: "rename_days", label: "Days between an owner's address changes", help: "Site staff can always change an address." },
]);

const int = (v, lo, hi, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** A clean config from anything (missing / bad values -> the defaults). `base` = the current config for a patch. */
function clean(raw, base = DEFAULTS) {
  const c = raw && typeof raw === "object" ? raw : {};
  const b = base && typeof base === "object" ? base : DEFAULTS;
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const [lo, hi] = LIMITS[k];
    out[k] = int(c[k] != null && c[k] !== "" ? c[k] : b[k], lo, hi, DEFAULTS[k]);
  }
  return out;
}

let CACHE = null;
async function get() {
  if (CACHE) return CACHE;
  const rooms = require("./rooms");
  await rooms.init();
  let raw = null;
  try { raw = JSON.parse((await rooms.kvGet("pads_cfg")) || "null"); } catch (e) { raw = null; }
  CACHE = clean(raw);
  return CACHE;
}
async function set(patch, actor) {
  const rooms = require("./rooms");
  const cur = await get();
  const next = clean(patch, cur);
  await rooms.kvSet("pads_cfg", JSON.stringify(next));
  await rooms.event(null, "pads-cfg", actor || null, JSON.stringify(next));
  CACHE = next;
  return next;
}
const _reset = () => { CACHE = null; };

/** GET/POST /api/pads/admin/config - site Admins (money settings live here). */
function register(app, { addUser }) {
  const json = require("express").json({ limit: "8kb" });
  const isAdmin = (u) => !!u && u.class === "Admin";
  app.get("/api/pads/admin/config", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!require("./rooms").isStaff(req.user)) return res.status(403).json({ ok: false, error: "Staff only." });
    res.json({ ok: true, config: await get(), defaults: DEFAULTS, limits: LIMITS });
  });
  app.post("/api/pads/admin/config", addUser, json, async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    try { res.json({ ok: true, config: await set(req.body || {}, req.user.username) }); }
    catch (e) { console.error("[padcfg]", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
}

module.exports = { get, set, clean, register, DEFAULTS, LIMITS, FIELDS, _reset };
