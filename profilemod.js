// profilemod.js - profmod (owner 2026-11-05: "Add admin moderation options to users menu from profile"): the ⋯ More menu's "Admin" group
// on someone else's profile (views/profile.ejs, public/js/profile-mod.js). It adds NO power and NO route: every item is an EXISTING
// per-account staff action, shown only to a viewer whose class holds that action's own capability (SP.can, so /admin/roles overrides
// apply - never a class name), and the action's own route checks it again when it runs:
//
//   item         capability (default)               route (unchanged)                                  sheet
//   ⛔ / ↩️ site ban  feed.moderate (Staff)        POST /api/rooms/<their profile pad>/ban|unban {scope: 'site'}  pad-ban-sheet.js (only: site)
//      (+ the networks box)  safety.net_bans (Admin)  the ban sheet's own box (netban.js, only while that switch is on)
//   🌐 web bridge, every room  bridge.blocks_global (Admin)  GET / POST /api/admin/bridge/blocks {target: 'u:<id>'}
//   🎬 / ↩️ main stage  stage.admin (Staff)        POST /api/stage/admin/ban {userId, reason} / unban {userId}
//   ⭐ creator status  creators.admin (Staff)      POST /api/admin/creators/:userId/status {action, note}   (only for a creator)
//   🖼️ stage cover    imagesafety.admin (Admin)   POST /api/admin/stage-cover/remove {user_id}             (only while one is up)
//   🔐 sign out everywhere  accounts.sessions_revoke (Admin)  POST /api/admin/users/:id/sessions/revoke {reason, confirm}
//   🔍 abuse details  feed.abuse_details (Admin)  GET /api/feed/admin/details?user=<id> (feed-safety.js; the view is logged)
//   links             accounts.security -> /admin/accounts?u=, feed.moderate + feed.admin_page -> /feed/admin#users (open reports),
//                     comps.manage -> /admin/comps?user=
//
// Who sees the group at all (the existing rules, padbans.rankRefusal's): a signed-in viewer, never on their own profile or a visitor
// preview, never on Pepe's / a Bot account, and never on PATV staff of the viewer's rank or above (an Assistant / Staff / Admin target
// needs a viewer of a HIGHER class). The viewer's class is read fresh here. (Review fixes: never on a deleted / merged - archived -
// account, never on your own alt - the same linked Camfrog login, the ban route's "That's you." rule; the target's row is read fresh too.) What the menu says about the person (an active site ban, a
// stage ban, creator status, a global bridge restriction, an uploaded cover, open reports) is only what the same capability already shows
// in /admin - and only for the holder of that capability; never a veil (incognito) ban, never who shares their networks (that look is
// logged - it stays in the ban sheet, as before).
"use strict";
const { getQuery } = require("./dbUtils");
const SP = require("./siteperms");
const core = require("./siteperms-core");

// item -> its route's capability (the route checks the same key)
const KEYS = Object.freeze({
  siteban: "feed.moderate", nets: "safety.net_bans", bridge: "bridge.blocks_global", stage: "stage.admin", creator: "creators.admin",
  cover: "imagesafety.admin", signout: "accounts.sessions_revoke", details: "feed.abuse_details", account: "accounts.security",
  reports: "feed.moderate", reportsPage: "feed.admin_page", comp: "comps.manage",
});
const ACCT_ID = /^[A-Za-z0-9-]{6,64}$/;          // personref.ACCT_RE's id (a {k: 'acct', v: 'u:<id>'} ref)
const n0 = (v) => (v == null ? null : Number(v));

/** May `viewer` see moderation for `target` at all (the rank rule)? -> the viewer's users row | null. */
async function eligible(viewer, target, { preview = false } = {}) {
  if (!viewer || !viewer.userId || preview || !target || !target.userId) return null;
  if (String(viewer.userId) === String(target.userId)) return null;                         // never on your own profile
  if (String(target.userId) === String(require("./feedstore").PEPE_ID) || target.class === "Bot") return null;   // never Pepe
  if (!core.classRank(viewer)) return null;               // (a member's session - addUser's class is the users row's - no query per view)
  const me = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [String(viewer.userId)]))[0];
  if (!me) return null;
  // review fixes: the target's own row, fresh - a deleted / merged (archived) account gets no group (its actions would land on a dead
  // account); your own alt (the same linked Camfrog login - the ban route's "That's you." rule) is you
  const them = (await getQuery("SELECT * FROM users WHERE userId = ?", [String(target.userId)]))[0];
  if (!them || them.archived_at) return null;
  const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
  if (low(me.camfrogUsername) && low(me.camfrogUsername) === low(them.camfrogUsername)) return null;
  if (them.class === "Bot") return null;
  const mine = core.classRank(me), theirs = core.classRank(them);
  if (!mine) return null;                                                                   // (no capability reaches a member)
  if (theirs > 0 && theirs >= mine) return null;                                            // staff of your rank or above
  return me;
}

/**
 * The profile's Admin group for this viewer, or null (nothing to show). viewer = req.user; target = the profile's users row
 * {userId, username, class}. opts.can = the capability check (SP.can; tests pass the view fallback).
 * -> { may: {item: bool}, userId, username, slug, siteBan, stageBan, creator, cover, bridge, reports }
 */
async function forProfile(viewer, target, { preview = false, can = SP.can, now = Date.now() } = {}) {
  const me = await eligible(viewer, target, { preview });
  if (!me) return null;
  const may = {};
  for (const [k, key] of Object.entries(KEYS)) may[k] = !!can(me, key);
  may.reports = may.reports && may.reportsPage;
  delete may.reportsPage;
  // (nets is never an item of its own - the ban sheet's box, which asks the server; it doesn't open the group)
  const any = () => Object.keys(may).some((k) => k !== "nets" && may[k]);
  if (!any()) return null;
  const uid = String(target.userId);
  const out = { may, userId: uid, username: target.username, ref: ACCT_ID.test(uid) ? { k: "acct", v: "u:" + uid } : { k: "user", v: target.username },
                slug: null, siteBan: null, stageBan: null, creator: null, cover: false, bridge: null, reports: 0 };
  const q = (sql, args) => getQuery(sql, args).catch(() => []);
  if (may.siteban) {
    // the site ban goes through the existing ban route of THEIR profile pad (scope 'site' = room '' - the same row /feed/admin lists)
    try { const P = await require("./rooms").ensureProfile(uid); out.slug = P && P.slug ? P.slug : null; } catch (e) { out.slug = null; }
    if (!out.slug) may.siteban = false;
    const b = (await q("SELECT until, reason, by FROM feed_bans WHERE user_id = ? AND room_id = '' AND (until IS NULL OR until > ?)", [uid, now]))[0];
    if (b) out.siteBan = { until: n0(b.until), reason: b.reason || "", by: b.by || "" };
  }
  if (may.reports) out.reports = Number(((await q("SELECT COUNT(*) AS n FROM user_reports WHERE target_id = ? AND resolved_at IS NULL", [uid]))[0] || {}).n) || 0;
  if (may.stage) {
    const s = (await q("SELECT reason, by, at FROM stage_bans WHERE userId = ?", [uid]))[0];
    if (s) out.stageBan = { reason: s.reason || "", by: s.by || "", at: n0(s.at) };
  }
  if (may.creator) {
    const c = (await q("SELECT status FROM creators WHERE user_id = ?", [uid]))[0];
    if (c && c.status) out.creator = { status: String(c.status) };
    else may.creator = false;                                       // (not a creator: nothing to pause - approvals stay on /admin/creators)
  }
  if (may.cover) {
    const c = (await q("SELECT upload FROM stage_covers WHERE user_id = ?", [uid]))[0];
    out.cover = !!(c && c.upload);
    if (!out.cover) may.cover = false;
  }
  if (may.bridge) {
    const rows = await q("SELECT feature, until FROM bridge_blocks WHERE user_id = ? AND room_id = '' AND (until IS NULL OR until > ?) ORDER BY feature", [uid, now]);
    if (rows.length) out.bridge = { features: rows.map((r) => r.feature || "all"), until: rows.some((r) => r.until == null) ? null : Math.max(...rows.map((r) => Number(r.until))) };
  }
  if (!any()) return null;
  return out;
}

/** "2026-11-05 14:00 UTC" (the ban sheet's format). */
function utc(ms) { try { return new Date(Number(ms)).toISOString().slice(0, 16).replace("T", " ") + " UTC"; } catch (e) { return ""; } }

module.exports = { forProfile, eligible, utc, KEYS };
