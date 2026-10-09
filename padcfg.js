// padcfg.js — the site-admin settings for pad addresses, user-made pads and platform connections (1.99iy+).
// Stored as one JSON value in rooms_kv "pads_cfg"; every value is clamped on the way in and on the way out, so a
// bad row can't break a page. Money settings (the creation fee) are the user's call: the default is 0 (free).
//
//   rename_days      an owner may change their pad's address once per this many days (site staff: any time)
//   (1.99iz) create  user-made pads: on/off, who may (linked account, account age, level), how many, the fee
//   (1.99iz) reclaim inactive empty pads go back to the pool after N days - OFF by default
"use strict";

// key -> {type: int | bool | select, def, lo/hi (int), options (select)}
const SPEC = Object.freeze({
  rename_days: { type: "int", def: 30, lo: 0, hi: 365 },
  // 1.99iz: user-made pads (padcreate.js)
  create_on: { type: "bool", def: true },
  create_link: { type: "select", def: "any", options: ["any", "camfrog", "none"] },
  create_min_age_days: { type: "int", def: 7, lo: 0, hi: 365 },
  create_min_level: { type: "int", def: 2, lo: 0, hi: 100 },
  create_max_per_user: { type: "int", def: 2, lo: 0, hi: 20 },
  create_fee: { type: "int", def: 0, lo: 0, hi: 10000000 },          // PAT; 0 = free (the user decides)
  reclaim_on: { type: "bool", def: false },
  reclaim_days: { type: "int", def: 90, lo: 7, hi: 3650 },
});
const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(SPEC).map(([k, v]) => [k, v.def])));
const LIMITS = Object.freeze(Object.fromEntries(Object.entries(SPEC).filter(([, v]) => v.type === "int").map(([k, v]) => [k, [v.lo, v.hi]])));

// what the admin form shows for each setting (views/partials/pads-admin-cfg.ejs draws these)
const FIELDS = Object.freeze([
  { key: "rename_days", label: "Days between an owner's address changes", help: "Site staff can always change an address." },
  { key: "create_on", type: "bool", label: "Members can create pads", help: "A new pad starts as a site pad (feed, stage and chat on the website); its owner can connect it to Camfrog or Twitch later." },
  { key: "create_link", type: "select", label: "Creating a pad needs a linked account",
    options: [["any", "Any linked account (Camfrog, Discord or Twitch)"], ["camfrog", "A linked Camfrog name"], ["none", "No link needed"]] },
  { key: "create_min_age_days", label: "Minimum account age (days)" },
  { key: "create_min_level", label: "Minimum level" },
  { key: "create_max_per_user", label: "Pads one member can create (and still own)", help: "Pads an admin gave them don't count. Site staff have no limit." },
  { key: "create_fee", money: true, label: "Creation fee (PAT)", help: "Charged once when the pad is made, to Fort Knox (the Federal Reserve while Fort Knox isn't live). 0 = free." },
  { key: "reclaim_on", type: "bool", label: "Reclaim empty pads", help: "A member-made site pad with no posts at all, untouched for the days below, is removed and its address freed (the owner is told). Off by default." },
  { key: "reclaim_days", label: "Reclaim after (days without posts or changes)" },
]);

const int = (v, lo, hi, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const bool = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";

/** A clean config from anything (missing / bad values -> the defaults). `base` = the current config for a patch. */
function clean(raw, base = DEFAULTS) {
  const c = raw && typeof raw === "object" ? raw : {};
  const b = base && typeof base === "object" ? base : DEFAULTS;
  const out = {};
  for (const [k, S] of Object.entries(SPEC)) {
    const has = c[k] != null && c[k] !== "";
    const v = has ? c[k] : b[k];
    if (S.type === "bool") out[k] = v == null ? S.def : bool(v);
    else if (S.type === "select") out[k] = S.options.includes(String(v)) ? String(v) : (S.options.includes(String(b[k])) ? String(b[k]) : S.def);
    else out[k] = int(v, S.lo, S.hi, S.def);
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

module.exports = { get, set, clean, register, SPEC, DEFAULTS, LIMITS, FIELDS, _reset };
