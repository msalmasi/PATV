// padsite.js — "Pepe on your pad's page" (1.99up): the owner panel's card for what Pepe does on the pad's SITE side - its
// feed and its page - for ANY pad (not only one connected to a chat room). One place, per pad, three groups:
//
//   POSTS        posts         his own posts in the pad (pepefeed `posts`; unset = the old `auto` switch)
//                post_kinds    which kinds (pepefeed KINDS: recap / question / dj / news / snaps; unset = all)
//                posts_per_day how many a day (pepefeed posts_per_day)
//                announce      "X just went live" / "Now playing" in the pad (golive.js golive_pad.announce)
//   COMMENTS     replies       answering mentions (pepefeed respond)
//                comments      commenting on fresh posts by himself (pepefeed `comments`; unset = `auto`)
//                comment_rate  low | normal | high = comments_per_day + gap_min (RATES)
//   MODERATION   automod       Pepe's feed automod in the pad (feedautomod on - an optional extra, default off)
//                automod_level relaxed | standard | strict (LEVELS = what minor / serious / severe verdicts do)
//   and feed     "Pepe on this pad's feed" at all (pepefeed enabled) - the master switch the others sit under
//
// Each value is the REAL effective one, read back from the store that enforces it (pepefeed.scopeSettings,
// feedautomod.settings, golive.padAnnounce) - the site applies these itself, no Pepe round trip; Pepe follows them from
// his next feed sync. Every setting INHERITS the default (SPEC .def, shown "Default (on)") until the owner overrides it;
// "Reset to default" clears the stored value. A setting counts as overridden when this card set it (pad_site_overrides)
// or when the stored value differs from the default (the pad settings' Pepe tab writes the same stores).
//
// SAFETY FLOOR - never here, never switchable by an owner: image safety on uploads (imagesafety.js), reports and the
// admins' queue, the TAKE IT DOWN process (takedown.js), the CSAM escalation, and - while the automod is on - a severe
// verdict is at least hidden (feedautomod SEVERE_FLOOR). Owners choose Pepe's optional extras and how strict they are
// above that floor. A site admin's lock on a pad's Pepe / automod settings (admin_lock) still holds.
//
// Limits: SET_MAX changes per account + pad per minute and HOUR_MAX per hour (staff exempt). Audit: every change and
// reset is a room_events row ("pepe-site") on top of the stores' own logs (pepe_feed_log, feed-automod-settings).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const rooms = require("./rooms");

const RATES = Object.freeze({ low: { comments_per_day: 4, gap_min: 60 }, normal: { comments_per_day: 10, gap_min: 30 }, high: { comments_per_day: 25, gap_min: 15 } });
const LEVELS = Object.freeze({ relaxed: { minor: "none", serious: "flag", severe: "hide" }, standard: { minor: "flag", serious: "flag", severe: "hide" },
                               strict: { minor: "flag", serious: "hide", severe: "remove" } });
const PER_DAY = Object.freeze([1, 2, 3, 5, 10]);
const PF = () => require("./pepefeed");
const AM = () => require("./feedautomod");
const GL = () => require("./golive");

// key -> {group, type, def, choices?}. def = the site default a pad inherits.
const SPEC = Object.freeze({
  feed: { group: "general", type: "bool", def: true },
  posts: { group: "posts", type: "bool", def: false },
  post_kinds: { group: "posts", type: "kinds", def: null },          // null = every kind
  posts_per_day: { group: "posts", type: "choice", def: 1, choices: PER_DAY },
  labels: { group: "posts", type: "bool", def: true },              // 1.99wq: he flairs + tags his posts from the pad's own (pepelabels.js)
  announce: { group: "posts", type: "bool", def: true },
  replies: { group: "comments", type: "bool", def: true },
  comments: { group: "comments", type: "bool", def: false },
  comment_rate: { group: "comments", type: "choice", def: "normal", choices: Object.keys(RATES) },
  automod: { group: "moderation", type: "bool", def: false },
  automod_level: { group: "moderation", type: "choice", def: "standard", choices: Object.keys(LEVELS) },
});
const GROUPS = Object.freeze([["general", "🐸", ["feed"]], ["posts", "📝", ["posts", "post_kinds", "posts_per_day", "labels", "announce"]],
  ["comments", "💬", ["replies", "comments", "comment_rate"]], ["moderation", "🛡️", ["automod", "automod_level"]]]);
// the protections owners never change (shown read-only on the card)
const FLOOR = Object.freeze(["image_safety", "reports", "takedown", "csam", "severe_hidden", "admin_lock"]);
const SET_MAX = 20, SET_WINDOW_MS = 60e3, HOUR_MAX = 100;
const HITS = new Map();
let NOW = () => Date.now();

let ready = null;
function init() {
  if (!ready) {
    ready = runQuery(`CREATE TABLE IF NOT EXISTS pad_site_overrides (room_id TEXT NOT NULL, key TEXT NOT NULL, by_user TEXT, updated INTEGER NOT NULL,
                      PRIMARY KEY (room_id, key))`).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

function rateOf(S) {
  for (const [k, v] of Object.entries(RATES)) if (S.comments_per_day === v.comments_per_day && S.gap_min === v.gap_min) return k;
  return "custom";
}
function levelOf(A) {
  for (const [k, v] of Object.entries(LEVELS)) if (A.minor === v.minor && A.serious === v.serious && A.severe === v.severe) return k;
  return "custom";
}

/** The card: {values: {key: {value, def, own, locked}}, groups, floor, locked, kinds} - every value the effective one. */
async function state(roomId) {
  await init();
  const id = String(roomId || "");
  const S = await PF().scopeSettings(id);
  const A = await AM().settings(id);
  const ann = await GL().padAnnounce(id);
  const annSet = await GL().padAnnounceSet(id);
  const own = new Set((await getQuery("SELECT key FROM pad_site_overrides WHERE room_id = ?", [id])).map((r) => r.key));
  const kinds = PF().kindsOf(S);
  const eff = {
    feed: S.enabled !== false, posts: PF().postsOn(S), post_kinds: kinds.length === PF().KINDS.length ? null : kinds,
    posts_per_day: S.posts_per_day, labels: S.labels !== false, announce: ann, replies: S.respond !== false, comments: PF().commentsOn(S), comment_rate: rateOf(S),
    automod: !!A.on, automod_level: levelOf(A),
  };
  const values = {};
  for (const [k, sp] of Object.entries(SPEC)) {
    const v = eff[k];
    const same = JSON.stringify(v) === JSON.stringify(sp.def);
    values[k] = { value: v, def: sp.def, own: own.has(k) || !same || (k === "announce" && annSet !== null),
                  locked: sp.group === "moderation" ? !!A.admin_lock : !!S.admin_lock };
  }
  return { values, groups: GROUPS, floor: FLOOR, kinds: PF().KINDS.slice(), rates: RATES, levels: LEVELS, per_day: PER_DAY,
           automod: { minor: A.minor, serious: A.serious, severe: A.severe, floor: AM().SEVERE_FLOOR, profile: !!A.profile } };
}

function limit(user, roomId) {
  if (SP.can(user, "pads.manage_any")) return null;
  const k = user.userId + "|" + roomId, t = NOW();
  const hits = (HITS.get(k) || []).filter((x) => t - x < 3600e3);
  const minute = hits.filter((x) => t - x < SET_WINDOW_MS);
  if (minute.length >= SET_MAX) return `That's a lot of changes at once - try again in ${Math.ceil((SET_WINDOW_MS - (t - minute[0])) / 1000)} s.`;
  if (hits.length >= HOUR_MAX) return "That's a lot of changes this hour - try again later.";
  hits.push(t);
  HITS.set(k, hits);
  if (HITS.size > 5000) HITS.clear();
  return null;
}

/** One change (or a reset to the default) by the pad's owner / staff. -> the new state(). */
async function set(user, roomId, key, value, { reset = false } = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const id = String(roomId || "");
  if (!(await rooms.get(id))) throw new Refuse(404, "No such pad.");
  if (!(await rooms.canManage(user, id))) throw new Refuse(403, "Only this pad's owner can do that.");
  const sp = SPEC[key];
  if (!sp) throw new Refuse(400, "That isn't a setting you can change here.");
  // check the value BEFORE counting it
  let v = value;
  if (!reset) {
    if (sp.type === "bool") {
      if (typeof v === "string") v = v === "on" || v === "true" ? true : v === "off" || v === "false" ? false : null;
      if (typeof v !== "boolean") throw new Refuse(400, "On or off.");
    } else if (sp.type === "choice") {
      if (key === "posts_per_day") v = Number(v);
      if (!sp.choices.includes(v)) throw new Refuse(400, "Pick one of the choices.");
    } else if (sp.type === "kinds") {
      if (!Array.isArray(v)) throw new Refuse(400, "Pick the kinds.");
      v = PF().KINDS.filter((k) => v.includes(k));
    }
  }
  const why = limit(user, id);
  if (why) throw new Refuse(429, why);
  const pf = PF(), am = AM();
  if (reset) {
    if (key === "feed") await pf.resetScope(user, id, ["enabled"]);
    else if (key === "posts") await pf.resetScope(user, id, ["posts"]);
    else if (key === "post_kinds") await pf.resetScope(user, id, ["kinds"]);
    else if (key === "posts_per_day") await pf.resetScope(user, id, ["posts_per_day"]);
    else if (key === "labels") await pf.resetScope(user, id, ["labels"]);
    else if (key === "replies") await pf.resetScope(user, id, ["respond"]);
    else if (key === "comments") await pf.resetScope(user, id, ["comments"]);
    else if (key === "comment_rate") await pf.resetScope(user, id, ["comments_per_day", "gap_min"]);
    else if (key === "announce") await GL().resetPadAnnounce(user, id);
    else if (key === "automod") await am.setScope(user, id, { on: sp.def });
    else if (key === "automod_level") await am.setScope(user, id, { ...LEVELS[sp.def] });
    await runQuery("DELETE FROM pad_site_overrides WHERE room_id = ? AND key = ?", [id, key]);
  } else {
    if (key === "feed") await pf.setScope(user, id, { enabled: v });
    else if (key === "posts") await pf.setScope(user, id, { posts: v });
    else if (key === "post_kinds") await pf.setScope(user, id, { kinds: v });
    else if (key === "posts_per_day") await pf.setScope(user, id, { posts_per_day: v });
    else if (key === "labels") await pf.setScope(user, id, { labels: v });
    else if (key === "replies") await pf.setScope(user, id, { respond: v });
    else if (key === "comments") await pf.setScope(user, id, { comments: v });
    else if (key === "comment_rate") await pf.setScope(user, id, { ...RATES[v] });
    else if (key === "announce") await GL().setPadAnnounce(user, id, v);
    else if (key === "automod") await am.setScope(user, id, { on: v });
    else if (key === "automod_level") await am.setScope(user, id, { ...LEVELS[v] });
    await runQuery(`INSERT INTO pad_site_overrides (room_id, key, by_user, updated) VALUES (?, ?, ?, ?)
                    ON CONFLICT(room_id, key) DO UPDATE SET by_user = excluded.by_user, updated = excluded.updated`, [id, key, user.username || null, NOW()]);
  }
  await rooms.event(id, "pepe-site", user.username || "?", reset ? `${key} reset to default` : `${key}=${JSON.stringify(v)}`).catch(() => {});
  return state(id);
}

function register(app, { addUser }) {
  const express = require("express");
  const bad = (res, st, error) => res.status(st).json({ ok: false, error });
  const jsonOnly = (req, res, next) => (req.is("application/json") && req.get("X-Requested-With") === "fetch" ? next() : bad(res, 400, "Bad request."));
  app.post("/api/rooms/:slug/owner/site", addUser, express.json({ limit: "2kb" }), jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.user || !req.user.userId) return bad(res, 401, "Sign in first.");
      const R = await require("./roomsweb").resolveRoom(req.params.slug);
      if (!R) return bad(res, 404, "No such pad.");
      const b = req.body || {};
      const acct = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0] || req.user;
      res.json({ ok: true, site: await set(acct, R.id, String(b.key || ""), b.value, { reset: b.reset === true }) });
    } catch (e) {
      if (e && e.refuse) return bad(res, e.status || 400, e.message);
      console.error("[padsite]", e);
      bad(res, 500, "Something went wrong - nothing was changed.");
    }
  });
}

module.exports = { init, register, state, set, SPEC, GROUPS, FLOOR, RATES, LEVELS, PER_DAY, Refuse,
                   _reset: () => HITS.clear(), _setClock: (fn) => { NOW = fn; } };
