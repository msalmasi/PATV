// feedautomod.js — Pepe's feed automod (1.99dc). When it's on in a pad, Pepe reads new posts and comments there
// and judges them against the pad's own rules (padrules.js) - or, for a pad without rules, the site-wide
// guidelines (Padiquette, guidelines.js) - with the site's hard limits always on top. The model call happens in
// Pepe (camfrog-bot pepe_feedmod.py, the model router's "feed_automod" function, a cheap tier); this file is the
// authority on WHAT HAPPENS: it hands out the work, checks every verdict, maps it to an action, applies it,
// tells the author and logs it. Pepe never picks the action by himself and never bans anyone.
//
// Settings per scope (feed_kv "automod:scope:<id>", '' = All: the site admins' settings):
//   on               default OFF. A house pad with no settings of its own follows All; owners' pads are opt-in
//                    (the owner, or a site admin from the pad's settings hub, switches it on).
//   minor / serious / severe   what to do at each severity: none | flag | hide | remove.
//                    Defaults: flag / flag / hide = "flag everything to the owner's queue, auto-hide only the severe
//                    categories" (illegal content, doxxing, credible threats, CSAM, NCII).
//   admin_lock       an admin froze these settings (the owner sees them, can't change them)
//   on_since         when it was last switched on - nothing older is judged (no retroactive sweep)
// Global (feed_kv "automod:global", admins): enabled (master switch), budget_usd (Pepe's model spend on automod per
// rolling 24 h, spend tag feed_automod), per_day (verdicts per rolling 24 h). Both are enforced here (no work is
// handed out past them) and checked again by Pepe against his own cost ledger.
//
// The verdict Pepe sends: {action, rule, severity, reason} (strict JSON from the model, parsed again here):
//   action    none | flag | hide | remove - the MODEL's ceiling ("flag" = unsure, "remove" = clear-cut)
//   rule      the id of the rule it breaks: a pad rule ("r1".."r15") or a site rule (guidelines.RULES ids)
//   severity  minor | serious | severe (site rules: the rule's own severity wins - it's category-driven;
//             pad rules: the model's, at most "serious")
//   reason    one short sentence citing the rule (shown to the author and the owner)
// decide(): final action = min(pad's setting for that severity, the model's action). A rule id that isn't in the
// list Pepe was given -> no action (free speech by default). CSAM: at least hide, ALWAYS escalated through the
// existing urgent path (every admin gets the urgent notice; hidden site-wide), whatever the pad's settings say; the
// author is never told (the CSAM procedure), and only site staff can reverse it.
//
// What each action does: flag = a report from Pepe in the pad's queue (reason = the rule's report category, note =
// his reason) - child-safety / NCII / illegal content reports go to the site admins, like a human's; hide = flag +
// hidden in that pad pending review (a comment: hidden on its post); remove = flag + taken out of that pad (a
// comment: removed). Every action: an inbox notice to the author (with the rule, the reason, and the appeal route),
// a room_events row ("feed-automod"), and a feed_automod row the owner can REVERSE from the pad's settings hub
// (undoes the hide / remove, closes Pepe's report, tells the author; logged "feed-automod-reverse").
// Never judged: Pepe's own content, site staff, the pad's own owner.
// 1.99df: profile pads (rooms.js platform "profile") have no automod settings of their own and are OFF by default. One
// global switch (automod:global "profiles", admins, /feed/admin) turns it on for every profile at once; they then use
// the All scope's severity settings (scope '' in the log and the budget) and are judged against Padiquette. The
// owner's own posts are never judged (they're the pad owner), so in practice it's other people's comments.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const store = require("./feedstore");
const rooms = require("./rooms");
const padrules = require("./padrules");
const G = require("./guidelines");

const PEPE_ID = store.PEPE_ID;
const DAY = 86400e3;
const WINDOW = 6 * 3600e3;                 // only content this fresh is judged
const BATCH = 8;                           // items per sync
const SEVERITIES = Object.freeze(["none", "minor", "serious", "severe"]);
const ACTIONS = Object.freeze(["none", "flag", "hide", "remove"]);
const RANK = { none: 0, flag: 1, hide: 2, remove: 3 };
const DEFAULTS = Object.freeze({ on: false, minor: "flag", serious: "flag", severe: "hide", admin_lock: false });
const GLOBAL_DEFAULTS = Object.freeze({ enabled: true, budget_usd: 0.25, per_day: 400, profiles: false });
const REASON_MAX = 240;
const APPEAL = "/terms#moderation";
const BY = "pepe-automod";
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await store.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_automod (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        post_id TEXT, comment_id TEXT, room_id TEXT NOT NULL DEFAULT '', author_id TEXT, at INTEGER NOT NULL, action TEXT NOT NULL,
        severity TEXT, rule TEXT, rule_title TEXT, reason TEXT, model_action TEXT, model TEXT, cost REAL NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'done', reversed_at INTEGER, reversed_by TEXT, note TEXT, notified INTEGER NOT NULL DEFAULT 0)`);
      await runQuery("CREATE INDEX IF NOT EXISTS feed_automod_room ON feed_automod (room_id, at)");
      await runQuery("CREATE INDEX IF NOT EXISTS feed_automod_at ON feed_automod (at)");
    })().catch((e) => { console.error("[automod] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// ── settings ──
const bool = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
const act = (v, d) => (ACTIONS.includes(v) ? v : d);
function cleanScope(c) {
  c = c && typeof c === "object" ? c : {};
  const o = { ...DEFAULTS };
  if (c.on != null) o.on = bool(c.on);
  if (c.admin_lock != null) o.admin_lock = bool(c.admin_lock);
  for (const k of ["minor", "serious", "severe"]) o[k] = act(c[k], DEFAULTS[k]);
  if (Number(c.on_since) > 0) o.on_since = Math.floor(Number(c.on_since));
  return o;
}
function cleanGlobal(c) {
  c = c && typeof c === "object" ? c : {};
  const o = { ...GLOBAL_DEFAULTS };
  if (c.enabled != null) o.enabled = bool(c.enabled);
  if (c.profiles != null) o.profiles = bool(c.profiles);                 // 1.99df: the automod on every profile
  if (Number(c.profiles_since) > 0) o.profiles_since = Math.floor(Number(c.profiles_since));
  if (c.budget_usd != null && c.budget_usd !== "") { const n = Number(c.budget_usd); if (Number.isFinite(n)) o.budget_usd = Math.round(Math.min(20, Math.max(0, n)) * 100) / 100; }
  if (c.per_day != null && c.per_day !== "") { const n = Math.floor(Number(c.per_day)); if (Number.isFinite(n)) o.per_day = Math.min(5000, Math.max(0, n)); }
  return o;
}
async function readJson(key) { try { return JSON.parse((await store.kvGet(key)) || "null"); } catch (e) { return null; } }
/** A scope's settings. A house pad without its own follows All (inherited: true). */
async function settings(scope) {
  await init();
  scope = String(scope || "");
  const own = await readJson("automod:scope:" + scope);
  // 1.99df: a profile follows the global "profiles" switch with the All scope's severities - never its own settings
  if (scope && rooms.isProfile(scope)) {
    const Gc = await globalCaps();
    return { ...(await settings("")), on: !!Gc.profiles, on_since: Gc.profiles_since || 0, inherited: true, profile: true };
  }
  if (scope && own == null) {
    const R = rooms.getCached(scope);
    if (R && R.house) return { ...(await settings("")), inherited: true };
  }
  return cleanScope(own);
}
async function globalCaps() { await init(); return cleanGlobal(await readJson("automod:global")); }

const isAdmin = (u) => !!u && u.class === "Admin";
/** Change a scope's settings: All = site Admins; a pad = its owner (unless admin-locked) or an Admin. */
async function setScope(user, scope, patch) {
  await init();
  scope = String(scope || "");
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const admin = isAdmin(user);
  if (!scope) { if (!admin) throw new Refuse(403, "Only site admins set the automod for All."); }
  else if (rooms.isProfile(scope)) throw new Refuse(403, "Profiles follow the site-wide automod switch for profiles (site admins, /feed/admin).");   // 1.99df
  else {
    if (!(await rooms.get(scope))) throw new Refuse(404, "No such pad.");
    if (!admin && !(await rooms.canManage(user, scope))) throw new Refuse(403, "Only this pad's owner can do that.");
  }
  const cur = cleanScope(await readJson("automod:scope:" + scope));
  if (cur.admin_lock && !admin) throw new Refuse(403, "A site admin has locked the automod settings for this pad.");
  const p = { ...(patch || {}) };
  if (!admin) delete p.admin_lock;
  delete p.on_since;
  const next = cleanScope({ ...cur, ...p });
  if (next.on && !cur.on) next.on_since = NOW();
  await store.kvSet("automod:scope:" + scope, JSON.stringify(next));
  const note = `${next.on ? "on" : "off"} · minor=${next.minor} serious=${next.serious} severe=${next.severe}${next.admin_lock ? " · locked" : ""}`;
  if (scope) await rooms.event(scope, "feed-automod-settings", user.username, note);
  console.log(`[automod] settings scope=${scope || "All"} by=${user.username}: ${note}`);
  return settings(scope);
}
async function setGlobal(user, patch) {
  if (!isAdmin(user)) throw new Refuse(403, "Admins only.");
  await init();
  const cur = await globalCaps();
  const next = cleanGlobal({ ...cur, ...(patch || {}) });
  if (next.profiles && !cur.profiles) next.profiles_since = NOW();         // 1.99df: nothing older is judged
  await store.kvSet("automod:global", JSON.stringify(next));
  console.log(`[automod] global by=${user.username}: ${JSON.stringify(next)}`);
  return next;
}

// ── verdicts ──
/**
 * The model's answer -> {action, rule, severity, reason} or null (unparseable). Accepts an object or text with the
 * JSON somewhere in it (code fences, a sentence before it). Unknown values fall back to the safe side: action
 * "none", severity "none".
 */
function parseVerdict(raw) {
  let v = raw;
  if (typeof v === "string") {
    const s = v.replace(/```(?:json)?/gi, "");
    const i = s.indexOf("{"), j = s.lastIndexOf("}");
    if (i < 0 || j <= i) return null;
    try { v = JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = String(v.action == null ? "" : v.action).toLowerCase().trim();
  const sv = String(v.severity == null ? "" : v.severity).toLowerCase().trim();
  const rule = String(v.rule == null ? "" : v.rule).toLowerCase().trim().replace(/^\[|\]$/g, "").slice(0, 24);
  const reason = String(v.reason == null ? "" : v.reason).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, REASON_MAX);
  return { action: ACTIONS.includes(a) ? a : "none", rule: rule === "none" || rule === "null" ? "" : rule,
           severity: SEVERITIES.includes(sv) ? sv : "none", reason };
}

/** The rules Pepe judges a pad by: [{id, title, desc, severity (site rules) | null (pad rules)}] + the source. */
async function rulesFor(roomId) {
  const E = await padrules.effective(roomId);
  const list = E.source === "pad"
    ? E.rules.map((r) => ({ id: r.id, title: r.title, desc: r.desc, severity: null, pad: true })).concat(E.hard.map((r) => ({ ...r, pad: false })))
    : E.rules.map((r) => ({ ...r, pad: false }));
  return { source: E.source, intro: E.intro || "", list };
}

/**
 * verdict + the scope's settings + the rule list -> {action, severity, rule, ruleTitle, report, escalate, why}.
 * The model's action is a ceiling (it can only be MORE careful than the pad's setting), and the pad's setting is
 * a ceiling (Pepe never does more than the owner allowed) - except CSAM, which always hides and escalates.
 */
function decide(v, S, list) {
  const none = (why) => ({ action: "none", severity: "none", rule: v && v.rule ? v.rule : "", ruleTitle: "", report: null, escalate: false, why });
  if (!v) return none("unparseable verdict");
  if (v.action === "none" || v.severity === "none") return none("no violation");
  const R = (list || []).find((r) => r.id === v.rule);
  if (!R) return none(v.rule ? "cited a rule that isn't in this pad's list" : "no rule cited");
  let severity;
  if (R.pad) severity = v.severity === "severe" ? "serious" : v.severity;          // pad rules: minor | serious
  else severity = R.severity || v.severity;                                      // site rules: category-driven
  if (!["minor", "serious", "severe"].includes(severity)) return none("no severity");
  const site = R.pad ? null : G.rule(R.id);
  if (R.id === "csam") {
    return { action: RANK[S.severe] >= RANK.hide ? S.severe : "hide", severity: "severe", rule: R.id, ruleTitle: R.title, report: "csam", escalate: true, why: "csam" };
  }
  const allowed = act(S[severity], "none");
  const action = RANK[v.action] < RANK[allowed] ? v.action : allowed;
  return { action, severity, rule: R.id, ruleTitle: R.title, report: site ? site.report : "automod", escalate: false, why: "rule" };
}

// ── usage + work ──
async function usage(t = NOW()) {
  await init();
  const r = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS c FROM feed_automod WHERE at > ?", [t - DAY]))[0];
  return { count: r.n || 0, cost: Math.round((r.c || 0) * 1e6) / 1e6 };
}
/** The pads where the automod is on right now: [{room, scope, S}] (scope = '' when a house pad follows All). */
async function activePads() {
  const out = [];
  for (const R of await rooms.list()) {
    const S = await settings(R.id);
    if (S.on) out.push({ R, scope: S.inherited ? "" : R.id, S });
  }
  // 1.99df: every profile, when the admins switched the automod on for profiles
  const Gc = await globalCaps();
  if (Gc.profiles) {
    const S = await settings(rooms.PROFILE_PREFIX);
    for (const R of await rooms.profilePads()) out.push({ R, scope: "", S });
  }
  return out;
}
async function exempt(userId, roomId) {
  if (!userId || userId === PEPE_ID) return "Pepe";
  const u = (await getQuery("SELECT userId, class FROM users WHERE userId = ?", [userId]))[0];
  if (!u) return "account gone";
  if (store.isStaff(u)) return "staff";
  if (await rooms.canManage(u, roomId)) return "pad owner";
  return null;
}

/** For Pepe's sync: {caps: {...global, used}, items: [...]} - nothing when it's off or the day's budget is used. */
async function work(t = NOW()) {
  await init();
  const Gc = await globalCaps();
  const U = await usage(t);
  const caps = { ...Gc, used: U };
  if (!Gc.enabled || U.count >= Gc.per_day || U.cost >= Gc.budget_usd) return { caps, items: [] };
  const pads = await activePads();
  if (!pads.length) return { caps, items: [] };
  const PF = require("./pepefeed");
  const items = [], seen = new Set();
  const room = Math.max(0, Math.min(BATCH, Gc.per_day - U.count));
  for (const { R, scope, S } of pads) {
    if (items.length >= room) break;
    const since = Math.max(t - WINDOW, S.on_since || 0);
    const rules = await rulesFor(R.id);
    const pad = { id: R.id, slug: R.slug, title: R.title };
    const vision = await PF.scopeSettings(scope).then((x) => x.vision !== false).catch(() => true);
    const posts = await getQuery(`SELECT p.* FROM feed_posts p JOIN feed_post_rooms pr ON pr.post_id = p.id AND pr.room_id = ?
      WHERE p.created > ? AND p.deleted_at IS NULL AND pr.removed_at IS NULL AND p.author_id != ?
        AND NOT EXISTS (SELECT 1 FROM feed_automod a WHERE a.target = 'p:' || p.id) ORDER BY p.created LIMIT 20`, [R.id, since, PEPE_ID]);
    for (const p of posts) {
      if (items.length >= room) break;
      const target = "p:" + p.id;
      if (seen.has(target) || (await exempt(p.author_id, R.id))) continue;
      seen.add(target);
      const view = await PF.postView(p);
      items.push({ target, kind: "post", scope, room: pad, rules, vision, nsfw: !!store.effNsfw(p),
                   post: { id: p.id, title: view.title, body: view.body, link: view.link, images: view.images, media: view.media, source_id: view.source_id,
                           crosspost: view.crosspost ? { author: view.crosspost.author.display } : null },
                   author: { display: view.author.display }, created: p.created });
    }
    const cs = await getQuery(`SELECT c.*, p.title AS post_title, p.body AS post_body, par.body AS parent_body FROM feed_comments c
      JOIN feed_posts p ON p.id = c.post_id JOIN feed_post_rooms pr ON pr.post_id = c.post_id AND pr.room_id = ? AND pr.removed_at IS NULL
      LEFT JOIN feed_comments par ON par.id = c.parent_id
      WHERE c.created > ? AND c.deleted_at IS NULL AND c.author_id != ? AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM feed_automod a WHERE a.target = 'c:' || c.id) ORDER BY c.created LIMIT 30`, [R.id, since, PEPE_ID]);
    for (const c of cs) {
      if (items.length >= room) break;
      const target = "c:" + c.id;
      if (seen.has(target) || (await exempt(c.author_id, R.id))) continue;
      seen.add(target);
      const A = await store.account(c.author_id);
      items.push({ target, kind: "comment", scope, room: pad, rules, vision: false,
                   comment: { id: c.id, post: c.post_id, body: String(c.body || "").slice(0, 2000) },
                   context: { post_title: String(c.post_title || "").slice(0, 200), post_body: String(c.post_body || "").slice(0, 400),
                              parent: c.parent_body ? String(c.parent_body).slice(0, 400) : null },
                   author: { display: A ? A.displayname || A.username : "someone" }, created: c.created });
    }
  }
  return { caps, items };
}

// ── applying a verdict ──
async function target(t) {
  const m = /^([pc]):([A-Za-z0-9]{6,16})$/.exec(String(t || ""));
  if (!m) return null;
  if (m[1] === "p") {
    const p = await store.getRow(m[2]);
    return p ? { kind: "post", post: p, comment: null, author: p.author_id, deleted: !!p.deleted_at } : null;
  }
  const c = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [m[2]]))[0];
  if (!c) return null;
  return { kind: "comment", post: await store.getRow(c.post_id), comment: c, author: c.author_id, deleted: !!c.deleted_at };
}
const padHref = (R) => "/p/" + encodeURIComponent(R ? R.slug : "");
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

async function record(row) {
  const r = await runQuery(`INSERT OR IGNORE INTO feed_automod (target, kind, post_id, comment_id, room_id, author_id, at, action, severity, rule, rule_title,
    reason, model_action, model, cost, state, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.target, row.kind, row.post_id || null, row.comment_id || null, row.room_id || "", row.author_id || null, NOW(), row.action,
     row.severity || null, row.rule || null, row.rule_title || null, row.reason || null, row.model_action || null, row.model ? String(row.model).slice(0, 60) : null,
     Math.max(0, Math.min(Number(row.cost) || 0, 10)), row.state || "done", row.note ? String(row.note).slice(0, 300) : null]);
  return r && r.changes ? r.id || (await getQuery("SELECT id FROM feed_automod WHERE target = ?", [row.target]))[0].id : null;
}

/**
 * Pepe's verdict on one item. body: {target, room, verdict, cost, model} or {target, room, skip, cost}.
 * -> {ok, id, action, severity, rule} ({already: true} for a target judged before).
 */
async function apply(body) {
  await init();
  const b = body || {};
  const T = await target(b.target);
  if (!T) throw new Refuse(404, "No such post or comment.");
  if ((await getQuery("SELECT 1 FROM feed_automod WHERE target = ?", [String(b.target)]))[0]) return { ok: true, already: true };
  const roomId = String((b.room && b.room.id) || b.room || "");
  const R = rooms.getCached(roomId) || (roomId ? await rooms.get(roomId) : null);
  const base = { target: String(b.target), kind: T.kind, post_id: T.post ? T.post.id : null, comment_id: T.comment ? T.comment.id : null,
                 room_id: roomId, author_id: T.author, cost: b.cost, model: b.model };
  const placed = R && T.post ? (await getQuery("SELECT 1 FROM feed_post_rooms WHERE post_id = ? AND room_id = ? AND removed_at IS NULL", [T.post.id, R.id]))[0] : null;
  const S = R ? await settings(R.id) : null;
  let skip = b.skip ? String(b.skip).slice(0, 80) : null;
  if (!skip && (!R || !placed)) skip = "not in that pad";
  else if (!skip && !S.on) skip = "automod is off there";
  else if (!skip && T.deleted) skip = "already gone";
  else if (!skip && (await exempt(T.author, roomId))) skip = "exempt: " + (await exempt(T.author, roomId));
  if (skip) {
    const id = await record({ ...base, action: "none", state: "skipped", note: skip });
    return { ok: true, id, action: "none", skipped: skip };
  }
  const v = parseVerdict(b.verdict);
  const { list } = await rulesFor(R.id);
  const D = decide(v, S, list);
  const reason = v && v.reason ? v.reason : "";
  const id = await record({ ...base, action: D.action, severity: D.severity, rule: D.rule || (v && v.rule) || null, rule_title: D.ruleTitle || null,
                            reason: reason || null, model_action: v ? v.action : null, state: D.action === "none" ? "clear" : "done",
                            note: D.action === "none" ? D.why : null });
  if (!id) return { ok: true, already: true };
  if (D.action !== "none" || D.escalate) {
    await enforce(id, T, R, D, reason);
    console.log(`[automod] ${D.action}${D.escalate ? " +CSAM escalation" : ""} ${b.target} in ${R.id}: [${D.rule}] ${clip(reason, 100)}`);
  }
  return { ok: true, id, action: D.action, severity: D.severity, rule: D.rule };
}

async function enforce(id, T, R, D, reason) {
  const t = NOW();
  const isPost = T.kind === "post";
  const note = clip(`🤖 Pepe automod: ${reason || "breaks a rule"} [${D.ruleTitle}]`, 300);
  // flag (every action files one): a report from Pepe in the right queue
  await runQuery(`INSERT OR IGNORE INTO feed_reports (post_id, comment_id, reporter_id, reason, note, created) VALUES (?, ?, ?, ?, ?, ?)`,
                 [T.post.id, isPost ? null : T.comment.id, PEPE_ID, D.report || "automod", note, t]);
  if (D.escalate) {
    // the existing urgent CSAM path: hidden everywhere, every admin gets the urgent notice; the author is NOT told
    if (isPost) await runQuery("UPDATE feed_posts SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL", [t, T.post.id]);
    else await runQuery("UPDATE feed_comments SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL", [t, T.comment.id]);
    await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND sent_at IS NULL", [T.post.id]);
    console.error(`[automod] URGENT: Pepe flagged ${isPost ? "post " + T.post.id : "comment " + T.comment.id} as CSAM - hidden pending admin review`);
    if (store.urgentNotice) await store.urgentNotice(isPost ? "A post (Pepe automod)" : "A comment (Pepe automod)", "am" + id, true);
  }
  if (D.action === "hide") {
    if (isPost) await runQuery("UPDATE feed_post_rooms SET hidden_at = ?, hidden_by = ? WHERE post_id = ? AND room_id = ? AND hidden_at IS NULL", [t, BY, T.post.id, R.id]);
    else await runQuery("UPDATE feed_comments SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL", [t, T.comment.id]);
  } else if (D.action === "remove") {
    if (isPost) {
      await runQuery("UPDATE feed_post_rooms SET removed_at = ?, removed_by = ? WHERE post_id = ? AND room_id = ? AND removed_at IS NULL", [t, BY, T.post.id, R.id]);
      await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND room_id = ? AND sent_at IS NULL", [T.post.id, R.id]);
    } else {
      await runQuery("UPDATE feed_comments SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL", [t, BY, T.comment.id]);
      await store.recountPost(T.post.id).catch(() => {});
    }
  }
  const verb = { flag: "flagged", hide: "hid", remove: "removed" }[D.action] || "flagged";
  await rooms.event(R.id, "feed-automod", "Pepe", clip(`${verb} ${isPost ? "post " + T.post.id : "comment " + T.comment.id}: [${D.ruleTitle}] ${reason}`, 300));
  if (!D.escalate) {
    const what = isPost ? "post" : "comment";
    const told = { flag: `flagged your ${what} for the pad owner to look at - nothing has changed yet`, hide: `hid your ${what} until the pad owner reviews it`,
                   remove: `removed your ${what}` }[D.action];
    await store.notify(T.author, { kind: "feed", title: `Pepe's automod ${verb} your ${what} in p/${R.slug}`,
      body: `Rule: ${D.ruleTitle}. ${reason ? "Why: " + reason + " " : ""}Pepe ${told}. Think he got it wrong? The pad owner can reverse it, or you can appeal (${APPEAL}).`,
      link: "/feed/automod/" + id, ref: "automod:" + id });
    await runQuery("UPDATE feed_automod SET notified = 1 WHERE id = ?", [id]);
    if (D.action !== "flag" && R.owner && R.owner.userId && R.owner.userId !== T.author) {
      await store.notify(R.owner.userId, { kind: "feed", title: `Pepe's automod ${verb} a ${what} in p/${R.slug}`,
        body: `[${D.ruleTitle}] ${reason} - review or reverse it in the pad's settings.`, link: padHref(R) + "/settings#automod", ref: "automod-own:" + id });
    }
  }
}

/** The owner (or staff) undoes an automod action. CSAM ones: site staff only. -> the row */
async function reverse(user, id, note = "") {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const row = (await getQuery("SELECT * FROM feed_automod WHERE id = ?", [Number(id) || 0]))[0];
  if (!row) throw new Refuse(404, "No such automod action.");
  if (!(await rooms.canManage(user, row.room_id))) throw new Refuse(403, "Only this pad's owner can reverse it.");
  if (row.rule === "csam" && !store.isStaff(user)) throw new Refuse(403, "Child-safety actions are reviewed by the site admins.");
  if (row.state === "reversed") return row;
  if (!["flag", "hide", "remove"].includes(row.action) && row.rule !== "csam") throw new Refuse(409, "Nothing to reverse - Pepe took no action on it.");
  const t = NOW();
  if (row.kind === "post") {
    await runQuery("UPDATE feed_post_rooms SET hidden_at = NULL, hidden_by = NULL WHERE post_id = ? AND room_id = ? AND hidden_by = ?", [row.post_id, row.room_id, BY]);
    await runQuery("UPDATE feed_post_rooms SET removed_at = NULL, removed_by = NULL WHERE post_id = ? AND room_id = ? AND removed_by = ?", [row.post_id, row.room_id, BY]);
    if (row.rule === "csam") await runQuery("UPDATE feed_posts SET hidden_at = NULL WHERE id = ?", [row.post_id]);
  } else {
    if (row.action === "hide" || row.rule === "csam") await runQuery("UPDATE feed_comments SET hidden_at = NULL WHERE id = ?", [row.comment_id]);
    await runQuery("UPDATE feed_comments SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_by = ?", [row.comment_id, BY]);
    await store.recountPost(row.post_id).catch(() => {});
  }
  await runQuery(`UPDATE feed_reports SET resolved_at = ?, resolved_by = ?, action = 'automod-reversed' WHERE reporter_id = ? AND post_id = ?
                  AND COALESCE(comment_id, '') = ? AND resolved_at IS NULL`, [t, user.username, PEPE_ID, row.post_id, row.comment_id || ""]);
  const why = clip(note, 200);
  await runQuery("UPDATE feed_automod SET state = 'reversed', reversed_at = ?, reversed_by = ?, note = ? WHERE id = ?", [t, user.username, why || row.note, row.id]);
  await rooms.event(row.room_id, "feed-automod-reverse", user.username, clip(`#${row.id} ${row.action} ${row.kind} ${row.comment_id || row.post_id} [${row.rule_title || row.rule}]${why ? ": " + why : ""}`, 300));
  if (row.notified) {
    const R = rooms.getCached(row.room_id);
    await store.notify(row.author_id, { kind: "feed", title: `Pepe's automod call was reversed in p/${R ? R.slug : row.room_id}`,
      body: `The pad's moderators looked again and reversed it${row.action === "flag" ? "" : " - your " + row.kind + " is back"}.`, link: "/feed/automod/" + row.id, ref: "automod-rev:" + row.id });
  }
  console.log(`[automod] reversed #${row.id} by ${user.username}`);
  return (await getQuery("SELECT * FROM feed_automod WHERE id = ?", [row.id]))[0];
}

// ── views ──
async function decorateRows(rows) {
  const out = [];
  const urls = await store.postLinks(rows.map((r) => r.post_id)).catch(() => new Map());     // 1.99dv
  for (const r of rows) {
    let what = "";
    if (r.kind === "post") { const p = await store.getRow(r.post_id); what = p ? p.title || p.body || "(media post)" : "(gone)"; }
    else { const c = (await getQuery("SELECT body FROM feed_comments WHERE id = ?", [r.comment_id]))[0]; what = c ? c.body : "(gone)"; }
    const A = r.author_id ? await store.account(r.author_id) : null;
    const R = rooms.getCached(r.room_id);
    out.push({ ...r, what: clip(what, 140), author: A ? A.displayname || A.username : "?", authorUser: A ? A.username : null,
               pad: R ? { slug: R.slug, title: R.title } : { slug: r.room_id, title: r.room_id },
               href: (urls.get(r.post_id) || "/feed/p/" + r.post_id) + (r.comment_id ? "#c-" + r.comment_id : ""), reversible: r.state !== "reversed" && ["flag", "hide", "remove"].includes(r.action) });
  }
  return out;
}
/** A pad's automod log (newest first). */
async function list(roomId, limit = 50) {
  await init();
  return decorateRows(await getQuery("SELECT * FROM feed_automod WHERE room_id = ? ORDER BY id DESC LIMIT ?", [roomId, limit]));
}
async function adminList(limit = 100) {
  await init();
  return decorateRows(await getQuery("SELECT * FROM feed_automod WHERE state != 'skipped' ORDER BY id DESC LIMIT ?", [limit]));
}
/** One action for the notice page: its author, the pad's managers and staff only. */
async function noticeFor(user, id) {
  await init();
  const row = (await getQuery("SELECT * FROM feed_automod WHERE id = ?", [Number(id) || 0]))[0];
  if (!row || !user || !user.userId) return null;
  const manage = await rooms.canManage(user, row.room_id);
  if (row.author_id !== user.userId && !manage) return null;
  if (row.rule === "csam" && !store.isStaff(user)) return null;
  const [d] = await decorateRows([row]);
  const site = G.rule(row.rule);
  let ruleDesc = site ? site.desc : "";
  if (!site && row.rule) {
    const own = await padrules.get(row.room_id);
    const r = own && own.rules.find((x) => x.id === row.rule && x.title === row.rule_title);
    ruleDesc = r ? r.desc : "";
  }
  const R = rooms.getCached(row.room_id);
  return { ...d, ruleDesc, manage, mine: row.author_id === user.userId, appeal: APPEAL, guidelines: G.PATH,
           owner: R && R.owner ? R.owner.display || R.owner.username : null, ownerUser: R && R.owner ? R.owner.username : null, house: !!(R && R.house) };
}

// ── routes ──
function register(app, { addUser, isBotToken }) {
  const json = require("express").json({ limit: "32kb" });
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[automod]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const bot = (req, res, next) => {
    const tok = req.get("x-bot-token") || (req.body && typeof req.body.password === "string" ? req.body.password : "");
    if (!isBotToken(tok)) return res.status(403).json({ ok: false, error: "unauthorized" });
    next();
  };
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  const guard = (req, res, next) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const viewer = (req) => store.account(req.user.userId);
  const padOf = async (slug) => (await rooms.get(String(slug || ""))) || (await require("./roomsweb").resolveRoom(String(slug || "")));

  // Pepe: his verdicts (the work rides on /api/pepe/feed/sync)
  app.post("/api/pepe/feed/automod", json, bot, async (req, res) => { try { res.json(await apply(req.body || {})); } catch (e) { fail(res, e); } });

  app.post("/api/rooms/:slug/automod", addUser, json, guard, async (req, res) => {
    try {
      const R = await padOf(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      res.json({ ok: true, settings: await setScope(await viewer(req), R.id, (req.body || {}).settings) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/automod/:id/reverse", addUser, json, guard, async (req, res) => {
    try { res.json({ ok: true, row: await reverse(await viewer(req), req.params.id, (req.body || {}).note) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/admin/automod", addUser, json, guard, async (req, res) => {
    try {
      const v = await viewer(req), b = req.body || {};
      if (!isAdmin(v)) return res.status(403).json({ ok: false, error: "Admins only." });
      const out = { ok: true };
      if (b.global) out.global = await setGlobal(v, b.global);
      if (b.main) out.main = await setScope(v, "", b.main);
      res.json(out);
    } catch (e) { fail(res, e); }
  });
  // the notice page an automod inbox notice links to
  app.get("/feed/automod/:id", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
    try {
      const v = await viewer(req);
      const N = await noticeFor(v, req.params.id);
      res.set("X-Robots-Tag", "noindex");
      if (!N) return res.status(404).render("notFound", { user: req.user.username, heading: "Nothing here", message: "That automod notice isn't yours to see, or it doesn't exist.", title: "Not found" });
      res.render("automodNotice", { user: req.user.username, N, G });
    } catch (e) { console.error("[automod] notice:", e); res.status(500).send("Something went wrong."); }
  });
}

module.exports = {
  init, register, settings, setScope, globalCaps, setGlobal, parseVerdict, decide, rulesFor, work, apply, reverse, list, adminList, noticeFor, usage,
  cleanScope, cleanGlobal, DEFAULTS, GLOBAL_DEFAULTS, SEVERITIES, ACTIONS, WINDOW, BATCH, APPEAL, Refuse, _setClock,
};
