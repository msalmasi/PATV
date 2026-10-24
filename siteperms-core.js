// siteperms-core.js - 1.99ack site: the website's capability registry (release 2 of /admin/roles) and the pure check
// shared by siteperms.js (the site, with the overrides from site_perms) and the views' fallback.
//
// A view that checks a capability starts with (EJS tags written as [% %] here, because EJS includes this file and would
// run a real tag):
//   [% const can = locals.can || new Function(include('../siteperms-core.js'))().viewCan(locals); %]
// res.locals.can (siteperms.js) is the real one - the editable overrides, the request's user. A template rendered
// without the site (the tests use ejs.renderFile) gets the defaults. That's why this file is plain ES5 that also works
// as a function body (no EJS tags, no require): CommonJS allows the top-level `return`.
//
// Classes, lowest first: Assistant < Staff < Admin (staffroles.js: Pepe assistant / staff / owner+admin). A capability's
// minimum class is one of those three - nothing here ever reaches a member ("pleb") or any other class.
// A locked capability never changes (its reason is shown on /admin/roles); the others can be moved by Pepe's owners
// and admins on /admin/roles (siteperms.js has the edit rules).
"use strict";
// 1.99acl: no prototype - "constructor", "__proto__", "toString" ... are never a class or a key (every lookup also goes
// through rankOf / capOf, which ask hasOwnProperty).
var RANK = Object.create(null); RANK.assistant = 1; RANK.staff = 2; RANK.admin = 3;
var MIN_CLASSES = ["admin", "staff", "assistant"];
var CLASS_RANK = { Assistant: 1, Staff: 2, Admin: 3 };
var GROUPS = ["admin", "accounts", "economy", "games", "pads", "feed", "messages", "chat", "creators", "media", "stage", "sound", "pepe", "site"];
// Lock reasons (i18n siteperm.lock.<reason>)
var LOCKS = ["escalation", "credentials", "points", "privacy", "consent", "ops", "safety", "padlock", "exposure"];

// [key, group, default minimum class, lock reason or null]
var CAPS = [
  // ── the admin area, roles ──
  ["admin.area", "admin", "staff", null],                       // /admin and every page in it (Assistants: only the pages they hold a capability for)
  ["admin.sensitive_overview", "admin", "admin", "privacy"],    // Overview / Economy / Games: Pepe, Reserve, loans, stale cleanup, admin-only cards
  ["roles.assign", "admin", "admin", "escalation"],             // Admin -> Users -> assign a class (+ Pepe's role ladder)
  ["roles.class_list", "admin", "admin", "escalation"],         // add / remove classes
  ["keys.view", "admin", "admin", "credentials"],               // /admin/keys
  ["keys.manage", "admin", "admin", "credentials"],             // mint / rotate / revoke (and a Pepe owner)
  // ── accounts ──
  ["users.xp", "accounts", "admin", null],
  ["users.welcome_stale", "accounts", "admin", "points"],       // welcome bonus "pay anyway", stale-account cleanup
  ["accounts.security", "accounts", "admin", "privacy"],
  ["accounts.delete_other", "accounts", "admin", "privacy"],
  ["accounts.sessions_revoke", "accounts", "admin", "privacy"],
  ["auth.signin_methods", "accounts", "admin", "privacy"],
  ["profile.see_private", "accounts", "admin", "privacy"],
  ["history.lookup", "accounts", "staff", "privacy"],           // anyone's PAT history (1.99acl: locked)
  // ── economy ──
  ["econ.grant_pat", "economy", "admin", "points"],
  ["econ.house_adjust", "economy", "admin", "points"],
  ["econ.codes_manage", "economy", "admin", "points"],
  ["econ.codes_view", "economy", "admin", "points"],            // 1.99acl: was Staff - a live code is redeemable PAT (owner decision)
  ["econ.pepe_econ_cmds", "economy", "admin", "points"],
  ["econ.burn", "economy", "admin", "points"],
  ["econ.padvault_move", "economy", "admin", "points"],
  ["econ.telemetry_policy", "economy", "admin", "points"],
  ["econ.vwm_view", "economy", "staff", null],
  ["econ.backend_cutover", "economy", "admin", "points"],
  ["econ.boost_challenge_cosmetic_cfg", "economy", "admin", "points"],   // 1.99ack: was Staff (owner decision 2026-10-18)
  ["premium.admin", "economy", "admin", "points"],                       // 1.99ack: was Staff (owner decision 2026-10-18)
  ["comps.manage", "economy", "admin", "points"],
  ["crypto.admin", "economy", "admin", "points"],
  ["donations.admin", "economy", "admin", "points"],
  ["escrow.override", "economy", "admin", "points"],
  // ── games ──
  ["games.config", "games", "admin", "points"],
  ["markets.auto", "games", "admin", null],
  ["raffles.admin", "games", "admin", "points"],
  ["raffles.house", "games", "admin", "points"],                // a House raffle: its PAT prize is paid by the House (1.99ack: split from raffles.admin)
  ["oracle.admin", "games", "admin", "points"],
  ["casino.admin", "games", "admin", "points"],
  ["quotes.free", "games", "admin", null],
  ["launchpad.admin", "games", "admin", null],
  ["launchpad.metrics", "games", "staff", null],
  // ── pads ──
  ["pads.manage_any", "pads", "staff", null],                   // manage any pad as if its owner (rooms.canManage)
  ["pads.pepe_ctl_any", "pads", "staff", "ops"],                // 1.99acl: Pepe into / out of any pad's room without Prime Time Plus (split from pads.manage_any)
  ["pads.registry_admin", "pads", "staff", null],               // /pads/admin: owners, front pad, tuning
  ["pads.royalties_config", "pads", "admin", "points"],         // 1.99ack: owner royalties config (was Staff)
  ["pads.vault_rate", "pads", "admin", "points"],               // 1.99ack: any pad's vault payout rate (owners keep their own)
  ["pads.config_view", "pads", "staff", null],
  ["pads.config", "pads", "admin", "points"],
  ["pads.approved_inside", "pads", "staff", "privacy"],
  ["pads.create_free", "pads", "staff", null],
  ["pads.connect_review", "pads", "assistant", null],           // 1.99ack: was Staff (owner decision 2026-10-18)
  ["pads.send_pepe", "pads", "admin", "ops"],
  ["bridge.blocks_global", "pads", "admin", null],
  ["bridge.cmdlog", "pads", "admin", null],
  ["chatlog.admin", "pads", "admin", "privacy"],                // CL2: the chat archive's switches, held un-hides, FTS repair (/admin/bridge)
  ["chatlog.read_all", "pads", "staff", "privacy"],             // CL6: every pad's full chat history (every read past a pad's public window is logged),
                                                                //      staff purge, the chat line report queue, the per-login tool, legal holds
  // ── feed, trust & safety ──
  ["feed.admin_page", "feed", "staff", null],
  ["feed.moderate", "feed", "staff", null],
  ["feed.see_hidden", "feed", "staff", "safety"],               // 1.99acl: locked - automod-hidden posts (suspected CSAM too), past paywalls / 18+
  ["feed.tags_remove_any", "feed", "staff", null],
  ["feed.limits_exempt", "feed", "staff", null],
  ["feed.config", "feed", "admin", null],
  ["feed.automod_global", "feed", "admin", null],
  ["feed.filter_admin", "feed", "admin", null],
  ["feed.pepe_admin", "feed", "admin", null],
  ["feed.admin_lock", "feed", "admin", "padlock"],              // set / pass a pad's admin lock (automod, filter, Pepe on the feed)
  ["feed.abuse_details", "feed", "admin", "privacy"],
  ["feed.automod_csam_reverse", "feed", "staff", "safety"],
  ["takedown.handle", "feed", "staff", "safety"],
  ["imagesafety.admin", "feed", "admin", "privacy"],
  // ── messages ──
  ["dm.limits_exempt", "messages", "staff", null],
  ["dm.report_review", "messages", "admin", "privacy"],
  // ── chat: the chat hub (S1 V1, ADR 0007 D15; adminchat.js, the admin nav's Chat group) ──
  ["chat.breakglass", "chat", "admin", "ops"],                  // /admin/chat: see it and turn the chat hub / a pad's hub chat OFF;
                                                                //   turning either ON is a Pepe owner's too (staffroles.ownerHolds)
  ["chat.mod_queue", "chat", "assistant", null],                // the hub's moderation screens (reports, held, mod log, bans; V2's
                                                                //   hosts) - the hub's own permissions decide what renders
  ["chat.audit", "chat", "admin", null],                        // the hub's audit and switches screens (V2's hosts)
  // ── creators, banner, shop ──
  ["creators.admin", "creators", "staff", "points"],             // refunds / clawbacks
  ["creators.config_explicit", "creators", "admin", null],
  ["creators.pad_flags_any", "creators", "staff", null],
  ["banner.review", "creators", "assistant", null],             // 1.99ack: was Staff (owner decision 2026-10-18)
  ["banner.config", "creators", "admin", "points"],
  ["shop.admin", "creators", "staff", "points"],                // orders, refunds, buyers' details
  ["shopart.view", "creators", "staff", null],
  ["shopart.admin", "creators", "admin", null],
  ["badges.manage", "creators", "staff", null],
  // ── media ──
  ["media.admin", "media", "admin", null],
  ["media.manage_requests", "media", "admin", null],
  ["media.library_free", "media", "admin", null],
  // ── stage, cams, streams ──
  ["stage.admin", "stage", "staff", null],
  ["stage.approval_bypass", "stage", "staff", null],
  ["onair.operate", "stage", "staff", null],
  ["onair.config", "stage", "admin", null],
  // 1.99acw: never below Staff (owner decision 2026-10-18) - both make Pepe's OBS (his home VM) load a third-party address
  ["onair.live_page", "stage", "staff", "exposure"],            // LIVE pages: Pepe's OBS opens the page itself (his home IP)
  ["onair.direct_media", "stage", "staff", "exposure"],         // direct pictures: no safety scan, loaded from the source host
  ["restream.staff", "stage", "staff", null],
  ["restream.main", "stage", "admin", "ops"],
  ["livecam.admin", "stage", "admin", "ops"],
  ["livecam.end_any", "stage", "staff", null],
  ["camclip.override", "stage", "admin", null],
  ["ghost.mode", "stage", "staff", "consent"],
  // micfollow: 🎙 mic follows on pad stages (/stage/admin) - never below Staff (a cam shown without anyone choosing it)
  ["micfollow.kill", "stage", "staff", "consent"],              // the kill switch + turning it off on one pad
  ["micfollow.admin", "stage", "admin", "ops"],                 // its knobs + the appearance log
  // ── soundboards, voices, likeness ──
  ["soundboards.moderate", "sound", "assistant", null],         // 1.99ack: was Staff (owner decision 2026-10-18)
  ["soundboards.config", "sound", "admin", "points"],
  ["voices.view", "sound", "staff", null],
  ["voices.manage", "sound", "admin", "points"],
  ["voiceclone.view", "sound", "staff", "consent"],
  ["voiceclone.decide", "sound", "admin", "consent"],
  ["likeness.view", "sound", "staff", null],                    // 1.99ack: was Admin + the old "Moderator" class (owner decision)
  ["likeness.manage", "sound", "admin", "points"],
  // ── Pepe, operations ──
  ["pepe.control", "pepe", "admin", "ops"],
  ["pepe.rooms_commands_audio", "pepe", "admin", "ops"],
  ["pepe.modlog", "pepe", "admin", "privacy"],
  ["ops.action_ttl", "pepe", "admin", "ops"],
  // ── site tools ──
  ["push.admin", "site", "admin", null],
  ["help.admin", "site", "admin", null],
  ["i18n.admin", "site", "admin", null],
];

var BY_KEY = Object.create(null);
for (var i = 0; i < CAPS.length; i++) {
  var c = CAPS[i];
  BY_KEY[c[0]] = { key: c[0], group: c[1], def: c[2], locked: c[3], label: "siteperm.k." + c[0] };
}

var own = function (o, k) { return o != null && typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k); };
/** The registry entry for key, or null - never an inherited property ("constructor", "__proto__", ...). */
function capOf(key) { return own(BY_KEY, key) ? BY_KEY[key] : null; }
/** One of the three class values ("admin" | "staff" | "assistant") -> its rank, anything else 0. */
function rankOf(cls) { return own(RANK, cls) ? RANK[cls] : 0; }
function isClass(cls) { return MIN_CLASSES.indexOf(cls) >= 0 && rankOf(cls) > 0; }

function strict() {
  try { return !!(typeof process !== "undefined" && process.env && (process.env.NODE_TEST_CONTEXT || process.env.SITEPERMS_STRICT)); } catch (e) { return false; }
}
var warned = Object.create(null);
/** An unknown key: a typo. Tests throw; production denies (and logs once). */
function unknown(key) {
  if (strict()) throw new Error("siteperms: unknown capability " + JSON.stringify(key));
  if (!warned[key]) { warned[key] = 1; try { console.error("[siteperms] unknown capability " + JSON.stringify(key) + " - denied"); } catch (e) { /* no console */ } }
  return false;
}
/** A user (object with .class / .cls, or a class name) -> 0 (no class here) .. 3 (Admin). Exact class names only. */
function classRank(u) {
  var cls = u == null ? null : typeof u === "string" ? u : (u["class"] != null ? u["class"] : u.cls);
  return Object.prototype.hasOwnProperty.call(CLASS_RANK, cls) ? CLASS_RANK[cls] : 0;
}
/** The minimum class that holds key, with these overrides ({key: "admin"|"staff"|"assistant"}). */
function minOf(overrides, key) {
  var cap = capOf(key);
  if (!cap) return null;
  if (cap.locked) return cap.def;
  var o = own(overrides, key) ? overrides[key] : null;
  return isClass(o) ? o : cap.def;
}
function check(overrides, u, key) {
  if (!capOf(key)) return unknown(key);
  var r = classRank(u);
  return r > 0 && r >= rankOf(minOf(overrides, key));
}
/** For views rendered without the site's middleware (tests): the defaults, for the subject given or the page's me / viewer. */
function viewCan(locals) {
  var L = locals || {};
  return function (key, u) {
    var who = u !== undefined ? u : (L.me || L.viewer || (L.isAdmin === true || L.admIsAdmin === true ? "Admin" : null));
    return check(null, who, key);
  };
}

var core = { RANK: RANK, MIN_CLASSES: MIN_CLASSES, CLASS_RANK: CLASS_RANK, GROUPS: GROUPS, LOCKS: LOCKS, CAPS: CAPS, BY_KEY: BY_KEY,
             classRank: classRank, capOf: capOf, rankOf: rankOf, isClass: isClass, minOf: minOf, check: check, viewCan: viewCan, strict: strict };
if (typeof module !== "undefined" && module.exports) module.exports = core;
return core;
