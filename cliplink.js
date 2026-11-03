// cliplink.js — 1.99?? cliplink (the owner, 2026-11-03: "Let's make the 'linked Camfrog name' requirement for clips from bridge a per
// pad toggle"): a pad's "Clips from the website need a linked Camfrog name" switch, on /p/<slug>/settings?tab=camfrog.
//
// Before this, a 🔊 mic clip (micclip.js) and a 🎬 cam clip (camclip.js) from a pad page needed a signed-in PATV account WITH a linked
// Camfrog name, and Pepe re-checked every !clip rule AS that name (the role gate, admin = free, the price, his rate limits, the save
// charge and its refund on failure). The switch is per pad, ON by default (every pad behaves as before until its owner turns it off).
// Who may change it: rooms.canManage - the pad's owner, site staff and admins. It covers both kinds of clip, the preview and the post.
//
// OFF, a signed-in PATV account WITHOUT a linked Camfrog name may preview and post clips on that pad. Pepe acts as the ACCOUNT itself
// ("u:<userId>", camfrog-bot pepe_acctactor.py / pepe_cliplink.py):
//   * the !clip role gate treats it as "everyone" (refused while !clip is limited to a role);
//   * it is never an admin by Camfrog name (site admins keep their site-admin rule, camclip.clipAdmin);
//   * rate limits key on the PATV account (here: the user id, as for everyone; Pepe: "u:<userId>");
//   * the price is charged to ITS PATV account - Pepe's _charge_pat for "u:<userId>", the account path his website actions and 🐸
//     Pepe menu already use (find_or_create_user resolves it to that account, never creates one) - and refunded the same way;
//   * every other rule is unchanged: the room's !clip switch, private / hidden / incognito / transcripts-off speakers, bridge blocks,
//     the 18+ gate, the open-preview cap, "Remove me", veiled evidence.
// A linked account behaves exactly as before, whatever the switch says.
//
// Both sides must support it (an older Pepe never offers it, an older site never asks):
//   * Pepe says `clipacct_cap: 1` on his bridge sync and his action claim (actorcap.clipOn). Until he has, the site keeps today's
//     "Link your Camfrog name first" everywhere (the 🔊 Clip button, the 🎬 Clip popover, the request and the post).
//   * the site hands an unlinked clip job (bridge-relay.takeJobs) or website action (actions.js claim) out with `clip_acct: 1` ONLY
//     while the pad's switch is off at that moment; a job whose pad turned it back on is failed with the LINK answer instead.
//   * every bridge sync answer carries `clip_acct_rooms` (the pads whose switch is off, openRooms). Pepe takes an unlinked clip only
//     for a job carrying clip_acct: 1 AND a room on his latest list - a forged or old job (or an older site: no list) is refused.
// Stored in pad_clip_cfg (room_id -> need_link 0 / 1; a row only once an owner changed it). Keyed by the PAD, so it moves with the
// pad (padrekey.js: any room_id column; reloadCaches reloads this cache). Who changed it: the pad's room_events ("clips.link").
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");

const LINK = "Link your Camfrog name first: type !verify in a Camfrog room with Pepe.";   // the answer while a link is needed
const SET_MAX = 20, SET_WINDOW_MS = 60e3, HOUR_MAX = 100;
const OPEN_MAX = 2000;                              // pads on the sync list (all of them, in practice)
const HITS = new Map();
let NOW = () => Date.now();

const CACHE = new Set();                            // pad ids whose switch is OFF (no link needed); anything else needs one
let loaded = false, ready = null;

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code || null; this.refuse = true; } }

function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS pad_clip_cfg (room_id TEXT PRIMARY KEY, need_link INTEGER NOT NULL DEFAULT 1, updated INTEGER)");
      await loadCache();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** (Re)reads the switch of every pad (padrekey.reloadCaches calls it after a pad moved). */
async function loadCache() {
  const rows = await getQuery("SELECT room_id FROM pad_clip_cfg WHERE need_link = 0");
  CACHE.clear();
  for (const r of rows) CACHE.add(String(r.room_id));
  loaded = true;
}

/** Do clips from the website on this pad need a linked Camfrog name? (Not loaded yet / unknown pad: yes - today's rule.) */
function needLink(roomId) { return !(loaded && CACHE.has(String(roomId || ""))); }
/** Does the running Pepe take clips from a PATV account with no chat login? (actorcap.js: his clipacct_cap in the last 10 minutes) */
function capable() { try { return require("./actorcap").clipOn(); } catch (e) { return false; } }
/** May a signed-in account WITHOUT a linked Camfrog name clip on this pad right now? The pad's switch is off and Pepe can. */
function accountOk(roomId) { return !needLink(roomId) && capable(); }
/** The pads whose switch is off - for Pepe's bridge sync (clip_acct_rooms). */
function openRooms() { return loaded ? [...CACHE].slice(0, OPEN_MAX) : []; }

/** What the Camfrog tab's card shows (and the GET route answers). */
function state(roomId) {
  return { need_link: needLink(roomId), default_need_link: true, capable: capable() };
}

function limit(user, roomId) {
  if (SP.can(user, "pads.manage_any")) return null;
  const k = user.userId + "|" + roomId, t = NOW();
  const hits = (HITS.get(k) || []).filter((x) => t - x < 3600e3);
  if (hits.filter((x) => t - x < SET_WINDOW_MS).length >= SET_MAX || hits.length >= HOUR_MAX) return "That's a lot of changes at once - try again in a minute.";
  hits.push(t);
  HITS.set(k, hits);
  if (HITS.size > 5000) HITS.clear();
  return null;
}

async function mustManage(actor, R) {
  if (!actor || !actor.userId) throw new Refuse(401, "Sign in first.", "signin");
  if (!R || !R.id) throw new Refuse(404, "No such pad.", "no_pad");
  const rooms = require("./rooms");
  if (rooms.platformOf(R.id) !== "camfrog") throw new Refuse(400, "This pad has no Camfrog room, so it has no clips from the bridge.", "not_camfrog");
  if (!(await rooms.canManage(actor, R.id))) throw new Refuse(403, "Only this pad's owner (and site staff) can change its clip settings.", "not_owner");
}

/** The owner (or staff) sets the switch: body {need_link: bool}. -> state */
async function save(actor, R, body) {
  await init();
  await mustManage(actor, R);
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.need_link !== "boolean") throw new Refuse(400, "That setting is on or off.", "bad_value");
  const id = String(R.id);
  if (b.need_link === needLink(id)) return state(id);
  const lim = limit(actor, id);
  if (lim) throw new Refuse(429, lim, "rate");
  await runQuery(`INSERT INTO pad_clip_cfg (room_id, need_link, updated) VALUES (?, ?, ?)
                  ON CONFLICT(room_id) DO UPDATE SET need_link = excluded.need_link, updated = excluded.updated`, [id, b.need_link ? 1 : 0, NOW()]);
  if (b.need_link) CACHE.delete(id); else CACHE.add(id);
  await require("./rooms").event(id, "clips.link", actor.username || actor.userId || "?", b.need_link ? "clips need a linked Camfrog name" : "clips by any signed-in PATV account");
  console.log(`[cliplink] ${id}: clips from the website ${b.need_link ? "need a linked Camfrog name" : "open to signed-in PATV accounts"} (by ${actor.username || "?"})`);
  return state(id);
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[cliplink] init:", e.message));
  const express = require("express");
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "2kb" });
  const head = (res) => res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" });
  const bad = (res, st, error, code) => res.status(st).json({ ok: false, error, ...(code ? { code } : {}) });
  const fail = (res, e) => {
    if (e && e.refuse) return bad(res, e.status || 400, e.message, e.code);
    console.error("[cliplink]", e && e.message);
    bad(res, 500, "Something went wrong - nothing was changed.", "error");
  };
  const account = async (req) => (req.user && req.user.userId ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0] || req.user : null);
  const pad = (slug) => require("./roomsweb").resolveRoom(slug);

  app.get("/api/rooms/:slug/clip-settings", addUser, async (req, res) => {
    head(res);
    try {
      await init();
      const me = await account(req);
      const R = await pad(req.params.slug);
      await mustManage(me, R);
      res.json({ ok: true, ...state(R.id) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/clip-settings", addUser, json, async (req, res) => {
    head(res);
    // JSON from this site's own pages only
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return bad(res, 403, "Security check failed - reload the page.", "security");
    try { const me = await account(req); res.json({ ok: true, ...(await save(me, await pad(req.params.slug), req.body)) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, loadCache, register, needLink, capable, accountOk, openRooms, state, save, Refuse, LINK,
  _reset: () => { HITS.clear(); }, _setClock: (fn) => { NOW = fn || (() => Date.now()); } };
