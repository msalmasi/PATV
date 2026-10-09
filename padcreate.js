// padcreate.js — members create pads (1.99iz).
//
// A new pad is a SITE pad (platform "site", id patv:<random>): its feed, its stage and chat on the website, no Camfrog
// room behind it. Its owner can connect it to a Camfrog room or a Twitch channel later (padconnect.js, 1.99ja). The
// creator becomes the owner (owner_kind 'user'); origin = 'user', created_by = them; the slug they picked is a chosen
// one (slug_set = 1, so the address rules and the rename limit of padaddress.js apply).
//
// Who may (padcfg.js, site admins set it; site staff skip every check and pay nothing):
//   create_on               members can create pads at all (default on)
//   create_link             'any' linked account (Camfrog / Discord / Twitch, default) | 'camfrog' | 'none'
//   create_min_age_days     account age (default 7)            create_min_level   level (default 2)
//   create_max_per_user     pads they made and still own (default 2; pads an admin gave them don't count)
//   create_fee              PAT, charged once (default 0 = free - the user's call); goes to Fort Knox ("fortknox:pad_create"
//                           claim) while Fort Knox is live in Pepe, else to the Federal Reserve ("pad_create" claim)
// One creation per minute per account (a double click can't make two).
//
// Anti-squatting (reclaim_on, OFF by default; reclaim_days, default 90): a member-made SITE pad with no posts ever placed
// in it, created and last changed more than reclaim_days ago, and not connected to anything, is removed (its registry
// row, old addresses, follows, access / look / feed settings) and its owner gets an inbox notice. The sweep runs every
// 6 hours; /pads/admin shows how many pads it would take now.
//
//   GET  /pads/new                      the form (signed in), with what's missing when they can't yet
//   GET  /api/pads/check-slug?slug=     {ok, slug, problem}
//   POST /api/pads/create               {title, slug, description, visibility, banner} -> {ok, slug, href}
"use strict";
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");

const DAY = 24 * 3600e3;
let NOW = () => Date.now();
class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }
const recent = new Map();                 // userId -> last creation attempt (ms)
const GAP_MS = 60e3;

/** A users.created_at value ("YYYY-MM-DD HH:MM:SS" UTC, or ms) -> ms, or null. */
function createdMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) { const n = Number(v); return n > 1e12 ? n : n * 1000; }
  const t = Date.parse(String(v).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? "" : "Z"));
  return Number.isFinite(t) ? t : null;
}

async function account(userId) {
  const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const c = (k) => (cols.has(k) ? k : `NULL AS ${k}`);
  return (await getQuery(`SELECT userId, username, class, ${c("level")}, ${c("created_at")}, ${c("points_balance")}, ${c("camfrogUsername")},
                          ${c("discordId")}, ${c("twitchId")}, ${c("archived_at")} FROM users WHERE userId = ?`, [String(userId || "")]))[0] || null;
}
const linkedAny = (u) => !!(u && (u.camfrogUsername || u.discordId || u.twitchId));

/** How many pads `userId` made and still owns. */
async function madeCount(userId) {
  await rooms.init();
  const r = await getQuery("SELECT COUNT(*) AS n FROM rooms_registry WHERE owner_user_id = ? AND origin = 'user' AND COALESCE(platform, '') != 'profile'", [String(userId)]);
  return Number(r[0] && r[0].n) || 0;
}

/**
 * Can this account create a pad now? -> {ok, staff, reasons: [why not], fee, made, max, cfg, balance}.
 * Every reason is listed (the form shows them all), not just the first.
 */
async function eligibility(user, { now = NOW() } = {}) {
  const C = await require("./padcfg").get();
  const out = { ok: false, staff: false, reasons: [], fee: C.create_fee, made: 0, max: C.create_max_per_user, cfg: C, balance: 0 };
  if (!user || !user.userId) { out.reasons.push("Sign in to create a pad."); return out; }
  const u = await account(user.userId);
  if (!u || u.archived_at) { out.reasons.push("Your account isn't active."); return out; }
  out.balance = Number(u.points_balance) || 0;
  out.made = await madeCount(u.userId);
  if (rooms.isStaff(u)) { out.ok = true; out.staff = true; out.fee = 0; return out; }
  if (!C.create_on) out.reasons.push("Creating pads is switched off right now.");
  if (C.create_link === "camfrog" && !u.camfrogUsername) out.reasons.push("Link your Camfrog name first (type !verify in a Camfrog room with Pepe).");
  else if (C.create_link === "any" && !linkedAny(u)) out.reasons.push("Link an account first: your Camfrog name (!verify in a room with Pepe), Discord or Twitch.");
  const born = createdMs(u.created_at);
  if (C.create_min_age_days > 0) {
    const age = born ? (now - born) / DAY : 0;
    if (age < C.create_min_age_days) {
      const left = born ? Math.max(1, Math.ceil(C.create_min_age_days - age)) : C.create_min_age_days;
      out.reasons.push(`Your account needs to be ${C.create_min_age_days} days old (${left} more day${left === 1 ? "" : "s"}).`);
    }
  }
  if ((Number(u.level) || 0) < C.create_min_level) out.reasons.push(`You need level ${C.create_min_level} (you're level ${Number(u.level) || 0}).`);
  if (out.made >= C.create_max_per_user) {
    out.reasons.push(C.create_max_per_user ? `You already own ${out.made} pad${out.made === 1 ? "" : "s"} you made (the limit is ${C.create_max_per_user}).` : "Members can't create pads right now.");
  }
  if (C.create_fee > 0 && out.balance < C.create_fee) out.reasons.push(`A new pad costs ${C.create_fee.toLocaleString("en-US")} PAT - you have ${out.balance.toLocaleString("en-US")}.`);
  out.ok = !out.reasons.length;
  return out;
}

const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const cleanTitle = (v) => String(v == null ? "" : v).replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, 60);
const cleanDesc = (v) => String(v == null ? "" : v).replace(CTRL, "").trim().slice(0, 500);

/** A fresh site-pad id: patv:<12 hex> (never reused - the id is the pad's permanent key). */
async function newId() {
  for (;;) {
    const id = "patv:" + crypto.randomBytes(6).toString("hex");
    if (!(await getQuery("SELECT 1 FROM rooms_registry WHERE room_id = ?", [id])).length) return id;
  }
}

/** Create a pad. input: {title, slug, description, visibility (public | members | approved), banner}. -> the pad view. */
async function create(user, input = {}, { now = NOW() } = {}) {
  await rooms.init();
  const el = await eligibility(user, { now });
  if (!el.ok) throw new Refuse(403, el.reasons[0] || "You can't create a pad right now.");
  const last = recent.get(user.userId) || 0;
  if (!el.staff && now - last < GAP_MS) throw new Refuse(429, "One new pad a minute - give it a moment.");
  const title = cleanTitle(input.title);
  if (title.length < 3) throw new Refuse(400, "Give your pad a name (at least 3 characters).");
  const description = cleanDesc(input.description);
  const PAD = require("./padaddress");
  const { slug, problem } = await PAD.check(input.slug || title, null);
  if (problem) throw new Refuse(400, "Address: " + problem);
  let banner = "";
  if (input.banner != null && String(input.banner).trim()) {
    banner = rooms.cleanBanner(input.banner);
    if (banner === null) throw new Refuse(400, "The banner must be an https:// image link (or upload one in the pad's settings after).");
  }
  const PA = require("./padaccess");
  const vis = PA.LEVELS.includes(String(input.visibility || "").toLowerCase()) ? String(input.visibility).toLowerCase() : PA.DEFAULT;
  recent.set(user.userId, now);
  const id = await newId();
  const fee = el.staff ? 0 : el.fee;
  await require("./mainstage")._tx(async () => {
    // the address could have been taken since the check (another tab, another member): re-check inside the transaction
    if ((await getQuery("SELECT 1 FROM rooms_registry WHERE slug = ?", [slug])).length ||
        (await getQuery("SELECT 1 FROM pad_slug_aliases WHERE slug = ?", [slug])).length) throw new Refuse(409, "Someone just took that address - pick another.");
    if (!el.staff) {
      const n = await getQuery("SELECT COUNT(*) AS n FROM rooms_registry WHERE owner_user_id = ? AND origin = 'user' AND COALESCE(platform, '') != 'profile'", [user.userId]);
      if ((Number(n[0].n) || 0) >= el.max) throw new Refuse(403, `You already own ${el.max} pad${el.max === 1 ? "" : "s"} you made.`);
    }
    if (fee > 0) {
      const paid = await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?", [fee, user.userId, fee]);
      if (!paid.changes) throw new Refuse(402, `A new pad costs ${fee.toLocaleString("en-US")} PAT - you don't have enough.`);
      const label = `🧱 new pad p/${slug}`.slice(0, 120);
      await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)", [uuidv4(), user.userId, label, -fee]);
      await ensureClaims();
      let fk = false;
      try { fk = require("./funding").fortknoxLive(); } catch (e) { fk = false; }
      // negative = the website collected it: Pepe's funding tick credits Fort Knox ("fortknox:<flow>") or his Federal Reserve
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                     [uuidv4(), fk ? "fortknox:pad_create" : "pad_create", user.userId, label, -fee]);
    }
    const t = now;
    await runQuery(`INSERT INTO rooms_registry (room_id, slug, title, description, banner, owner_kind, owner_user_id, platform, slug_set, origin, created_by, created, updated)
                    VALUES (?, ?, ?, ?, ?, 'user', ?, 'site', 1, 'user', ?, ?, ?)`,
                   [id, slug, title, description || null, banner || null, user.userId, user.userId, t, t]);
    await runQuery("INSERT INTO rooms_kv (key, value) VALUES (?, 'user') ON CONFLICT(key) DO UPDATE SET value = excluded.value", ["seeded:" + id]);
  });
  await rooms.event(id, "pad-created", user.username || "?", `p/${slug} "${title}"${fee ? ` (fee ${fee} PAT)` : ""}`);
  await rooms.loadCache();
  const R = await rooms.get(id);
  if (vis !== PA.DEFAULT) {
    try { await PA.init(); await PA.setLevel(user, R, vis); } catch (e) { console.error("[pads] create visibility:", e.message); }
  }
  console.log(`[pads] ${user.username} created ${id} p/${slug}${fee ? ` (${fee} PAT)` : ""}`);
  return R;
}
async function ensureClaims() {
  await runQuery(`CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
                  created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)`);
}

// ── anti-squatting ──
/** Member-made site pads that would be reclaimed now (whatever the switch says). */
async function reclaimCandidates({ now = NOW() } = {}) {
  await rooms.init();
  const C = await require("./padcfg").get();
  const before = now - C.reclaim_days * DAY;
  const hasPosts = (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feed_post_rooms'")).length;
  const rows = await getQuery(`SELECT room_id, slug, title, owner_user_id, created, updated FROM rooms_registry
                               WHERE origin = 'user' AND platform = 'site' AND COALESCE(created, 0) < ? AND COALESCE(updated, 0) < ?
                               ${hasPosts ? "AND NOT EXISTS (SELECT 1 FROM feed_post_rooms pr WHERE pr.room_id = rooms_registry.room_id)" : ""}`, [before, before]);
  // a pad with a platform connection in progress (padconnect.js) is never reclaimed
  const busy = (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pad_connections'")).length
    ? new Set((await getQuery("SELECT DISTINCT room_id FROM pad_connections WHERE status IN ('pending', 'verified')")).map((r) => r.room_id)) : new Set();
  return rows.filter((r) => !busy.has(r.room_id));
}
/** Remove one (empty) pad: the row, its old addresses, follows and its own settings. Its events stay (audit). */
async function removePad(roomId) {
  const tables = new Set((await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  const del = async (t, sql, args) => { if (tables.has(t)) await runQuery(sql, args); };
  await del("rooms_registry", "DELETE FROM rooms_registry WHERE room_id = ?", [roomId]);
  await del("pad_slug_aliases", "DELETE FROM pad_slug_aliases WHERE room_id = ?", [roomId]);
  await del("follows", "DELETE FROM follows WHERE target_kind = 'room' AND target_id = ?", [roomId]);
  await del("pad_access", "DELETE FROM pad_access WHERE room_id = ?", [roomId]);
  await del("pad_members", "DELETE FROM pad_members WHERE room_id = ?", [roomId]);
  await del("pad_looks", "DELETE FROM pad_looks WHERE room_id = ?", [roomId]);
  await del("rooms_kv", "DELETE FROM rooms_kv WHERE key = ?", ["seeded:" + roomId]);
  if (tables.has("feed_kv")) {
    for (const k of ["room:", "rules:", "mention:", "mention_set:", "mention_at:", "automod:scope:", "pepe:scope:", "aigen_room:"]) {
      await runQuery("DELETE FROM feed_kv WHERE key = ?", [k + roomId]);
    }
  }
}
/** The sweep: OFF unless reclaim_on. -> {off} | {reclaimed: [{id, slug}]} */
async function reclaimSweep({ now = NOW() } = {}) {
  const C = await require("./padcfg").get();
  if (!C.reclaim_on) return { off: true, reclaimed: [] };
  const out = [];
  for (const r of await reclaimCandidates({ now })) {
    try {
      await require("./mainstage")._tx(() => removePad(r.room_id));
      await rooms.event(r.room_id, "pad-reclaimed", "auto", `p/${r.slug}: no posts in ${C.reclaim_days} days`);
      out.push({ id: r.room_id, slug: r.slug });
      if (r.owner_user_id) {
        await rooms.notify(r.owner_user_id, { kind: "feed", title: `Your pad p/${r.slug} was closed`, pm: false,
          body: `"${r.title || r.slug}" had no posts for ${C.reclaim_days} days, so its address went back to the pool. You can create a new pad any time.`, link: "/pads/new" });
      }
    } catch (e) { console.error("[pads] reclaim", r.room_id, e.message); }
  }
  if (out.length) { await rooms.loadCache(); try { await require("./padaccess").load(); } catch (e) { /* not loaded */ } console.log(`[pads] reclaimed ${out.length} empty pad(s): ${out.map((x) => x.slug).join(", ")}`); }
  return { reclaimed: out };
}

function register(app, { addUser, noTimers = false }) {
  const json = require("express").json({ limit: "8kb" });
  const sameSite = (req, res, next) => {
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    const site = req.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return res.status(403).json({ ok: false, error: "Cross-site request refused." });
    next();
  };
  app.get("/pads/new", addUser, async (req, res) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/pads/new"));
      const el = await eligibility(req.user);
      const PA = require("./padaccess");
      res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      res.render("padCreate", { user: req.user.username, el, levels: PA.LEVELS.map((k) => ({ key: k, ...PA.INFO[k] })), def: PA.DEFAULT,
                                min: require("./padaddress").MIN_LEN, max: require("./padaddress").MAX_LEN });
    } catch (e) { console.error("[pads] new:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/api/pads/check-slug", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const c = await require("./padaddress").check(String((req.query && req.query.slug) || ""), null);
      res.json({ ok: true, slug: c.slug, problem: c.problem });
    } catch (e) { console.error("[pads] check:", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/pads/create", addUser, json, sameSite, async (req, res) => {
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
      const R = await create(req.user, req.body || {});
      res.json({ ok: true, id: R.id, slug: R.slug, href: "/p/" + encodeURIComponent(R.slug) + "/settings?tab=general&created=1#look" });
    } catch (e) {
      const st = e && e.status && e.status < 500 ? e.status : 500;
      if (st === 500) console.error("[pads] create:", e);
      res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
    }
  });
  if (!noTimers) {
    const t = setInterval(() => { reclaimSweep().catch((e) => console.error("[pads] reclaim sweep:", e.message)); }, 6 * 3600e3);
    if (t.unref) t.unref();
  }
}

module.exports = { register, eligibility, create, madeCount, reclaimCandidates, reclaimSweep, removePad, createdMs, Refuse,
                   _setClock: (fn) => { NOW = fn || (() => Date.now()); }, _resetRecent: () => recent.clear() };
