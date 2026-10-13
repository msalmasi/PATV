// padsignals.js — 1.99vm: a pad's SITE activity right now, for pads WITHOUT a connected Camfrog room (the user, 2026-10-12:
// "open boosting and the front page to every pad"). The homepage's automatic pick and Top Pads (rooms.evaluateAuto /
// rooms.rankLive, frontroom.rank) rank bridge.summary() rows by people's chat / mic in the room; a site-only, Twitch or
// Discord pad has no such room, so this module gives it a row of the same shape from what happens ON the pad:
//
//   chatters  distinct QUALIFIED accounts (engagement.qualified: >= 7 days old, level >= 2, verified / linked, not
//             archived, not an alt) who posted, commented or upvoted on the pad's feed in the last window_min minutes
//             (Pepe never counts)
//   lines     posts + comments on the pad's feed in the window (by anyone but Pepe)
//   micMin    0 (no mic on the site yet)
//   people    signed-in viewers watching the pad's stage now (econ_watch heartbeats in the last 2 minutes, status ok)
//   lastAt    the newest of those (a post, a comment, an upvote, a heartbeat) - frontroom's "dead" test uses it
//   live      something happened in the window, or someone is watching now
// The ranking itself is unchanged (frontroom.rank: the same weights, boost points capped at half the activity score), so a
// pad without a chat room scores from its feed and stage only and will usually rank below a busy chat room - accepted
// (the user: later every pad gets native PATV chat). Approved (members-only) pads are left out by the caller as before.
//
// rows(windowMin, now) -> [{id, slug, name, count, live, micCount: 0, audio: false, people, site: true, act}] (cached 30 s)
// merge(summary, windowMin, now) -> the summary rows + a row for every pad the summary doesn't already have
"use strict";
const { getQuery } = require("./dbUtils");

const CACHE_MS = 30 * 1000;
const WATCH_NOW_MS = 2 * 60 * 1000;
const PEPE = "pepe-bot";
let clock = () => Date.now();
let cache = { at: 0, win: 0, rows: [] };

const safeQ = async (sql, args) => { try { return await getQuery(sql, args); } catch (e) { return []; } };

/** The pads that get a site row: registered, not a profile, without a connected Camfrog room. */
function sitePads() {
  const rooms = require("./rooms");
  return rooms.listCached().filter((R) => R && R.id && rooms.platformOf(R.id) !== "camfrog" && !rooms.isProfile(R.id));
}

async function build(windowMin, now) {
  const pads = sitePads();
  if (!pads.length) return [];
  const ids = pads.map((R) => R.id);
  const qs = ids.map(() => "?").join(",");
  const since = now - Math.max(1, Number(windowMin) || 20) * 60 * 1000;
  const acts = [
    ...(await safeQ(`SELECT home_pad AS pad, author_id AS uid, created AS at, 1 AS line FROM feed_posts
                     WHERE home_pad IN (${qs}) AND created >= ? AND deleted_at IS NULL`, [...ids, since])),
    ...(await safeQ(`SELECT p.home_pad AS pad, c.author_id AS uid, c.created AS at, 1 AS line FROM feed_comments c JOIN feed_posts p ON p.id = c.post_id
                     WHERE p.home_pad IN (${qs}) AND c.created >= ? AND c.deleted_at IS NULL`, [...ids, since])),
    ...(await safeQ(`SELECT p.home_pad AS pad, v.user_id AS uid, v.created AS at, 0 AS line FROM feed_votes v JOIN feed_posts p ON p.id = v.post_id
                     WHERE p.home_pad IN (${qs}) AND v.value > 0 AND v.created >= ?`, [...ids, since])),
  ].filter((r) => r.uid !== PEPE);
  const watch = await safeQ(`SELECT room_id AS pad, viewer_id AS uid, MAX(updated) AS at FROM econ_watch
                             WHERE room_id IN (${qs}) AND status = 'ok' AND updated >= ? GROUP BY room_id, viewer_id`, [...ids, now - WATCH_NOW_MS]);
  const people = [...new Set(acts.map((r) => String(r.uid)))];
  const q = people.length ? await require("./engagement").qualified(people, now).catch(() => ({})) : {};
  const per = new Map();
  const cell = (id) => { if (!per.has(id)) per.set(id, { chat: new Set(), lines: 0, viewers: new Set(), lastAt: 0 }); return per.get(id); };
  for (const r of acts) {
    const c = cell(r.pad);
    if (Number(r.line)) c.lines += 1;
    if (q[r.uid] && q[r.uid].ok) c.chat.add(String(r.uid));
    c.lastAt = Math.max(c.lastAt, Number(r.at) || 0);
  }
  for (const r of watch) {
    const c = cell(r.pad);
    c.viewers.add(String(r.uid));
    c.lastAt = Math.max(c.lastAt, Number(r.at) || 0);
  }
  const web = require("./roomsweb");
  return pads.map((R) => {
    const c = per.get(R.id) || { chat: new Set(), lines: 0, viewers: new Set(), lastAt: 0 };
    const viewers = c.viewers.size;
    return { id: R.id, slug: web.linkSlug ? web.linkSlug(R) : R.slug, name: R.title || R.slug, count: viewers, micCount: 0, audio: false,
             live: viewers > 0 || (c.lastAt >= since && (c.lines > 0 || c.chat.size > 0)), people: viewers, site: true, mic: [], topic: "",
             act: { chatters: c.chat.size, lines: c.lines, micMin: 0, people: viewers, lastAt: c.lastAt || null } };
  });
}

/** Site-activity rows for every pad without a connected Camfrog room (cached CACHE_MS per window). */
async function rows(windowMin = 20, now = clock()) {
  if (cache.rows && cache.win === windowMin && now - cache.at < CACHE_MS && now >= cache.at) return cache.rows;
  const r = await build(windowMin, now);
  cache = { at: now, win: windowMin, rows: r };
  return r;
}

/** summary rows (bridge.summary) + the site rows of pads it doesn't list. */
async function merge(summary, windowMin = 20, now = clock()) {
  const have = new Set((summary || []).map((r) => r && r.id));
  let extra = [];
  try { extra = (await rows(windowMin, now)).filter((r) => !have.has(r.id)); } catch (e) { console.error("[padsignals]", e.message); extra = []; }
  return (summary || []).concat(extra);
}

module.exports = { rows, merge, sitePads, _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { cache = { at: 0, win: 0, rows: [] }; } };
