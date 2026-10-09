// padaddress.js — changing a pad's address, p/<slug> (1.99iy).
//
// Who: the pad's owner and site staff (Admin / Staff), from the pad settings hub (General -> "Address"). House pads:
// staff only (canManage already says so). Profile pads (u/<name>) have no address of their own - never.
//
// Rules for a slug: 3-32 characters, a-z 0-9 and single hyphens, starting and ending with a letter or digit; not a
// reserved word (site paths, staff-ish names, platform names); not "u-..." (profile pads use that); not anybody
// else's current slug, an id-based slug, a slug the bridge shows for another Camfrog room, or a slug another pad gave
// up (those stay reserved for the redirects). Typed capitals / spaces / underscores are folded first.
//
// What a rename does (one transaction):
//   - the old slug goes to pad_slug_aliases (rooms.js) -> /p/<old>[/<anything>] 301s to the new address with the query
//     kept (pads.js), and the browser keeps any #hash through the redirect, so ?tab= / #feed links still land;
//     the bridge's display-name slug (when the pad's Camfrog room shows a different one) is kept as an alias too;
//   - renaming back to one of the pad's own old slugs takes that alias back;
//   - rooms_registry.slug + slug_set = 1 (links use the chosen slug from now on, not the bridge's) + slug_changed_at;
//   - per-account feed view choices stored under "p/<old>" (feed_view) move to "p/<new>";
//   - a "pad-address" event in the pad's log (the settings hub's audit log and its pad events).
// Everything else is keyed by the pad's stable id (rooms_registry.room_id) and is untouched: feed posts and their
// placements, follows, stories, captures, room vaults (room:<id> in Pepe), the bridge, royalties, boosts. Stage stream
// names / RTMP keys are random per slot / per user and never embed a slug. OG cards and post links are built from
// the current slug on every request. PATV has no sitemap.
//
// Limit: an owner may rename once per padcfg.rename_days (30 by default); staff any time.
//
//   GET  /api/rooms/:slug/address?slug=<want>   {ok, slug (folded), available, problem, can_rename_at}
//   POST /api/rooms/:slug/address {slug}        rename (JSON + same-site) -> {ok, slug, href}
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");

const MIN_LEN = 3;
const MAX_LEN = 32;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;
const DAY = 24 * 3600e3;
// site paths, things that would look official, platform names, and words that read as commands or placeholders
const RESERVED = new Set([
  "new", "create", "admin", "admins", "settings", "manage", "mod", "mods", "moderator", "moderators", "moderation", "staff",
  "api", "app", "www", "web", "site", "root", "system", "sys", "official", "support", "help", "about", "terms", "privacy",
  "rules", "guidelines", "padiquette", "contact", "security", "abuse", "report", "reports", "login", "logout", "register",
  "signup", "signin", "auth", "oauth", "account", "accounts", "profile", "profiles", "user", "users", "me", "you",
  "feed", "feeds", "all", "following", "popular", "trending", "top", "hot", "best", "search", "submit", "post", "posts",
  "pad", "pads", "p", "u", "rooms", "room", "stage", "live", "golive", "audio", "analytics", "hop", "stories", "story",
  "media", "messages", "inbox", "wallet", "economy", "markets", "market", "lotto", "polls", "wagers", "bounties", "gtf",
  "shop", "store", "rankings", "leaderboard", "achievements", "help-desk", "home", "index", "null", "undefined", "none",
  "nan", "true", "false", "test", "example", "everyone", "here", "random",
  "patv", "publicaccess", "public-access", "publicaccesstv", "pepe", "pepefrog", "pepebeta", "pepebot", "house",
  "camfrog", "twitch", "discord", "youtube",
]);

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

/** What the person typed, folded: trimmed, lower-case, spaces / underscores / dots -> "-", repeated "-" collapsed. */
function fold(raw) {
  return String(raw == null ? "" : raw).trim().toLowerCase().replace(/^\/?p\//, "")
    .replace(/[\s_.]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

/** Is a folded slug well-formed and not reserved? -> null, or why not (no uniqueness check). */
function formProblem(s) {
  if (!s) return "Type an address.";
  if (s.length < MIN_LEN) return `At least ${MIN_LEN} characters.`;
  if (s.length > MAX_LEN) return `At most ${MAX_LEN} characters.`;
  if (!SLUG_RE.test(s)) return "Letters a-z, digits and single hyphens only, starting and ending with a letter or digit.";
  if (/^\d+$/.test(s)) return "Use at least one letter.";
  if (RESERVED.has(s)) return `"${s}" is reserved.`;
  if (/^u-/.test(s)) return 'Addresses starting "u-" are for member profiles.';
  if (/^(patv|pepe|admin|staff|official)-/.test(s)) return "That prefix is reserved for the site.";
  return null;
}

/** The bridge's live rooms (the slug each one shows) - a Camfrog room Pepe is in keeps its address for its own pad. */
function bridgeHolder(s) {
  try {
    const B = require("./bridge");
    for (const R of B._rooms.values()) if (R.slug === s || B.slugify(R.id) === s) return R.id;
  } catch (e) { /* no bridge */ }
  return null;
}

/**
 * Can pad `roomId` (null = a pad that doesn't exist yet) take slug `s` (folded)? -> null, or why not.
 * Its own current slug and its own old slugs are fine.
 */
async function takenProblem(s, roomId) {
  await rooms.init();
  const alias = (await getQuery("SELECT room_id FROM pad_slug_aliases WHERE slug = ?", [s]))[0];
  if (alias && alias.room_id !== roomId) return "That address belonged to another pad and still points there.";
  const cur = alias ? null : rooms.bySlugCached(s);
  if (cur && cur.id !== roomId) return "Another pad already uses that address.";
  const held = bridgeHolder(s);
  if (held && held !== roomId) return "A Camfrog room Pepe is in uses that address.";
  return null;
}

/** Everything about slug `raw` for pad `roomId` -> {slug (folded), problem}. */
async function check(raw, roomId) {
  const slug = fold(raw);
  const problem = formProblem(slug) || (await takenProblem(slug, roomId));
  return { slug, problem };
}

/** When may `user` rename `R` next? -> ms timestamp (<= now = now), or null = never (not theirs / a profile). */
async function nextRenameAt(user, R) {
  if (!R || R.profile || rooms.isProfile(R.id)) return null;
  if (!(await rooms.canManage(user, R.id))) return null;
  if (rooms.isStaff(user)) return 0;
  const C = await require("./padcfg").get();
  const last = Number(R.slug_changed_at) || 0;
  return last ? last + C.rename_days * DAY : 0;
}

/** Rename pad `roomId` to `raw`. user = the account doing it (owner or staff). -> the pad (fresh view). */
async function rename(user, roomId, raw, { now = Date.now() } = {}) {
  await rooms.init();
  const R = await rooms.get(roomId);
  if (!R) throw new Refuse(404, "No such pad.");
  if (R.profile || rooms.isProfile(R.id)) throw new Refuse(400, "A profile's address is its member's username.");
  if (!(await rooms.canManage(user, R.id))) throw new Refuse(403, "Only this pad's owner (or a site admin) can change its address.");
  const at = await nextRenameAt(user, R);
  if (at && at > now) {
    const days = Math.ceil((at - now) / DAY);
    throw new Refuse(429, `You can change this pad's address again on ${new Date(at).toISOString().slice(0, 10)} (in ${days} day${days === 1 ? "" : "s"}). A site admin can change it sooner.`);
  }
  const { slug, problem } = await check(raw, R.id);
  if (problem) throw new Refuse(400, problem);
  if (slug === R.slug) throw new Refuse(400, "That's already this pad's address.");
  const old = R.slug;
  let bridgeSlug = null;
  try { const B = require("./bridge")._rooms.get(R.id); if (B && B.slug && B.slug !== old && B.slug !== slug) bridgeSlug = B.slug; } catch (e) { bridgeSlug = null; }
  const actor = (user && user.username) || "?";
  await require("./mainstage")._tx(async () => {
    await runQuery("DELETE FROM pad_slug_aliases WHERE slug = ? AND room_id = ?", [slug, R.id]);       // taking an old slug back
    await runQuery("INSERT OR IGNORE INTO pad_slug_aliases (slug, room_id, created, by) VALUES (?, ?, ?, ?)", [old, R.id, now, actor]);
    if (bridgeSlug && !(await takenProblem(bridgeSlug, R.id))) {
      await runQuery("INSERT OR IGNORE INTO pad_slug_aliases (slug, room_id, created, by) VALUES (?, ?, ?, ?)", [bridgeSlug, R.id, now, actor]);
    }
    const u = await runQuery("UPDATE rooms_registry SET slug = ?, slug_set = 1, slug_changed_at = ?, updated = ? WHERE room_id = ? AND slug = ?",
                             [slug, now, now, R.id, old]);
    if (!u.changes) throw new Refuse(409, "The pad changed while you were editing - reload and try again.");
    // per-account List / Gallery choices for this pad's feed (feedgallery.js) were stored under its slug
    const fv = await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feed_view'");
    if (fv.length) await runQuery("UPDATE OR REPLACE feed_view SET scope = ? WHERE scope = ?", ["p/" + slug, "p/" + old]);
  });
  await rooms.event(R.id, "pad-address", actor, `p/${old} -> p/${slug}${rooms.isStaff(user) && !(R.owner && user && R.owner.userId === user.userId) ? " (site staff)" : ""}`);
  await rooms.loadCache();
  // the bridge's live room shows the chosen slug from now on (bridge.roomFor reads slug_set)
  try { const B = require("./bridge")._rooms.get(R.id); if (B) B.slug = slug; } catch (e) { /* no bridge */ }
  console.log(`[pads] ${R.id}: p/${old} -> p/${slug} by ${actor}`);
  return rooms.get(R.id);
}

/** A pad's old addresses (newest first) - for its settings card. */
async function aliasesOf(roomId) {
  await rooms.init();
  return getQuery("SELECT slug, created, by FROM pad_slug_aliases WHERE room_id = ? ORDER BY created DESC LIMIT 20", [roomId]);
}

function register(app, { addUser }) {
  require("./padcfg").register(app, { addUser });      // the admin settings (/pads/admin "Pad addresses & creation")
  const json = require("express").json({ limit: "4kb" });
  const sameSite = (req, res, next) => {
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    const site = req.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return res.status(403).json({ ok: false, error: "Cross-site request refused." });
    next();
  };
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[pads] address:", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const resolve = (slug) => require("./roomsweb").resolveRoom(slug);
  app.get("/api/rooms/:slug/address", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
      const R = await resolve(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      if (!(await rooms.canManage(req.user, R.id))) return res.status(403).json({ ok: false, error: "Only this pad's owner can do that." });
      const want = String((req.query && req.query.slug) || "");
      const c = await check(want, R.id);
      const at = await nextRenameAt(req.user, R);
      res.json({ ok: true, slug: c.slug, available: !c.problem && c.slug !== R.slug, same: c.slug === R.slug, problem: c.problem,
                 can_rename_at: at && at > Date.now() ? at : 0 });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/address", addUser, json, sameSite, async (req, res) => {
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
      const R = await resolve(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      const out = await rename(req.user, R.id, (req.body || {}).slug);
      res.json({ ok: true, slug: out.slug, href: "/p/" + encodeURIComponent(out.slug) + "/settings?tab=general#address" });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, fold, formProblem, takenProblem, check, rename, nextRenameAt, aliasesOf, RESERVED, MIN_LEN, MAX_LEN, Refuse };
