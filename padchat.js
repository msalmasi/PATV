// padchat.js — CL3: a pad's 💬 Chat settings (the chat-history spec §2.5, §3.5 Settings): how far back visitors can scroll its
// chat, whether it can be searched, whether it can be downloaded, whether the room's Camfrog mods read everything.
//
//   /p/<slug>/settings?tab=chat           the tab (views/padSettings.ejs + public/js/pad-chat-settings.js); the owner panel shows
//                                         one summary row that links here (one home per setting); padowner WEB_CAPS web_chat_history
//   GET  /api/rooms/:slug/chat-settings   {window_s, search, downloads, mods_all, locked, effective: {chat_s, tx_s}, tier,
//                                          retention: {chat_days, rec_days}, open: {scope, effective} | null, closed, ...}
//   POST /api/rooms/:slug/chat-settings   {window_s: null | 0 | 60..315,360,000, search: bool, downloads: bool | null, mods_all: bool}
//                                         (any of them; the others stay)
//   POST   /api/rooms/:slug/chat-settings/open-earlier  {scope: window | search | both}   "Also open earlier history" (7 days later)
//   DELETE /api/rooms/:slug/chat-settings/open-earlier                                     cancel it while it's pending
//   POST /api/admin/chatlog/lock          {room, locked}  a site admin locks / unlocks a pad's chat settings (/admin/bridge)
//
// Who: rooms.canManage (the pad's owner and site staff); a lock holds for everyone but holders of chatlog.admin. Limits: 20 changes
// a minute and 100 an hour per account and pad (the padsite pattern; staff exempt). Site-applied: the values are the real ones,
// saved at once; Pepe reads them from the owner sync's `chatlog` block (CL4). Stored in pad_chat_cfg (chatlog.js owns the table;
// keyed by the PAD - it moves with the pad, padrekey). NULL = the default: the window "everything the tier keeps", search on,
// downloads on for Public / Members pads and off for Approved ones, mods 7 days past the public window.
// Every change: a room_events row (chat.history | chat.search | chat.downloads | chat.mods | chat.open_earlier | chat.lock), the
// watermarks reconciled at once (chatlogview.reconcile - a wider setting only shows lines said from now on), a 📜 note line in
// the pad's chat for the window and search (bridge.noteItem), and the pad's open pages woken so they re-filter.
// CL3 fix-up: every refusal carries a `code` - the tab (public/js/pad-chat-settings.js) shows it in the viewer's language
// (js.pad.chatset.err_<code>); the English `error` stays for older pages and the API.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");
const CL = require("./chatlog");

// ── owner decisions (spec §6) ──
const WINDOW_MIN = 60, WINDOW_MAX = 315360000;          // decision 3: a custom window is 1 minute .. 3,650 days
// decision 3: the presets (seconds; null = everything the tier keeps, the default)
const PRESETS = Object.freeze([0, 900, 3600, 21600, 86400, 259200, 604800, 2592000, 7776000, 31536000]);
const SET_MAX = 20, SET_WINDOW_MS = 60e3, HOUR_MAX = 100;
const LOCK_CAP = "chatlog.admin";                       // locks a pad's chat settings, and changes them past a lock
const HITS = new Map();
let NOW = () => CL.now();

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code || null; this.refuse = true; } }

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

/** A setting value from a request body -> the stored value, or throws a 400. */
function cleanWindow(v) {
  if (v === null) return null;
  if (typeof v === "number" && Number.isInteger(v) && (v === 0 || (v >= WINDOW_MIN && v <= WINDOW_MAX))) return v;
  throw new Refuse(400, "Pick Off, a time from 1 minute to 3,650 days, or Everything your tier keeps.", "bad_window");
}
function cleanBool(v, name, nullable = false) {
  if (typeof v === "boolean") return v;
  if (nullable && v === null) return null;
  throw new Refuse(400, `${name} is on or off.`, "bad_value");
}
const toInt = (b) => (b == null ? null : b ? 1 : 0);

/** What the 💬 Chat tab shows (and the GET route answers). */
async function state(padId, viewer = null) {
  await CL.init();
  const CV = require("./chatlogview");
  const id = String(padId || "");
  const V = await CV.view(id, null);
  const c = CL.padCfg(id);
  const tier = CV.padTier(id);
  const ret = CV.retFor(tier);
  const days = (s) => (s == null ? null : Math.round(s / 86400));
  return {
    window_s: c.window_s, search: c.search !== false, downloads: V.downloadsOn, downloads_set: c.downloads, downloads_default: V.level !== "approved",
    mods_all: !!c.mods_all, locked: c.locked, can_unlock: !!(viewer && SP.can(viewer, LOCK_CAP)),
    effective: { chat_s: V.eff.chat, tx_s: V.eff.tx }, tier: tier || "standard", retention: { chat_days: days(ret.chat), rec_days: days(ret.tx) },
    open: V.open, closed: V.closed, level: V.level, presets: PRESETS.slice(), min: WINDOW_MIN, max: WINDOW_MAX, updated: c.updated,
    open_days: Math.round(CV.OPEN_DELAY_MS / 864e5), mod_days: Math.round(CV.MOD_EXTRA_MS / 864e5),
  };
}
/** The owner panel's one row: {window_s, chat_s, search, downloads, mods_all, locked}. */
function summary(padId) {
  const id = String(padId || "");
  const c = CL.padCfg(id);
  let level = "members";
  try { level = require("./padaccess").levelOf(id); } catch (e) { level = "members"; }
  const eff = CL.effectiveWindows(id);
  return { window_s: c.window_s, chat_s: eff.chat, search: c.search !== false, downloads: c.downloads != null ? c.downloads : level !== "approved",
           mods_all: !!c.mods_all, locked: c.locked };
}

async function mustManage(actor, R) {
  if (!actor || !actor.userId) throw new Refuse(401, "Sign in first.", "signin");
  if (!R || !R.id) throw new Refuse(404, "No such pad.", "no_pad");
  const rooms = require("./rooms");
  if (rooms.isProfile(R.id)) throw new Refuse(400, "A profile has no pad chat.", "profile");
  if (!(await rooms.canManage(actor, R.id))) throw new Refuse(403, "Only this pad's owner (and site staff) can change its chat settings.", "not_owner");
}
function mustUnlocked(actor, id) {
  if (CL.padCfg(id).locked && !SP.can(actor, LOCK_CAP)) throw new Refuse(423, "A site admin has locked this pad's chat settings.", "locked");
}

async function writeRow(id, row, actorId) {
  const t = NOW();
  await runQuery(`INSERT INTO pad_chat_cfg (room_id, window_s, search, downloads, mods_all, locked, updated, by_user) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(room_id) DO UPDATE SET window_s = excluded.window_s, search = excluded.search, downloads = excluded.downloads,
                  mods_all = excluded.mods_all, locked = excluded.locked, updated = excluded.updated, by_user = excluded.by_user`,
                 [id, row.window_s, row.search, row.downloads, row.mods_all, row.locked ? 1 : 0, t, actorId || null]);
  const fresh = (await getQuery("SELECT * FROM pad_chat_cfg WHERE room_id = ?", [id]))[0] || null;
  CL.setPadCfgRow(id, fresh);
  return fresh;
}
/** The raw stored row (NULLs kept) - what a write starts from. */
async function rawRow(id) {
  const r = (await getQuery("SELECT * FROM pad_chat_cfg WHERE room_id = ?", [id]))[0];
  return r ? { window_s: r.window_s == null ? null : Number(r.window_s), search: r.search == null ? null : Number(r.search),
               downloads: r.downloads == null ? null : Number(r.downloads), mods_all: r.mods_all == null ? null : Number(r.mods_all), locked: !!r.locked }
           : { window_s: null, search: null, downloads: null, mods_all: null, locked: false };
}
const spanLabel = (s) => (s == null ? "everything" : s === 0 ? "off" : s % 86400 === 0 ? s / 86400 + "d" : s % 3600 === 0 ? s / 3600 + "h" : Math.round(s / 60) + "m");

/** The owner (or staff) changes some of the four settings. -> state */
async function save(actor, R, body) {
  await CL.init();
  await mustManage(actor, R);
  const id = R.id;
  mustUnlocked(actor, id);
  const b = body && typeof body === "object" ? body : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!["window_s", "search", "downloads", "mods_all"].some(has)) throw new Refuse(400, "Nothing to change.", "empty");
  const cur = await rawRow(id);
  const next = Object.assign({}, cur);
  if (has("window_s")) next.window_s = cleanWindow(b.window_s);
  if (has("search")) next.search = toInt(cleanBool(b.search, "Search"));
  if (has("downloads")) next.downloads = toInt(cleanBool(b.downloads, "Downloads", true));
  if (has("mods_all")) next.mods_all = toInt(cleanBool(b.mods_all, "Room mods can read all history"));
  const changed = ["window_s", "search", "downloads", "mods_all"].filter((k) => next[k] !== cur[k]);
  if (!changed.length) return state(id, actor);
  const lim = limit(actor, id);
  if (lim) throw new Refuse(429, lim, "rate");
  const before = CL.padCfg(id), effBefore = CL.effectiveWindows(id);
  await writeRow(id, next, actor.userId);
  const CV = require("./chatlogview");
  await CV.reconcileNow(id);
  const after = CL.padCfg(id), effAfter = CL.effectiveWindows(id);
  const rooms = require("./rooms");
  const who = actor.username || actor.userId || "?";
  if (changed.includes("window_s")) await rooms.event(id, "chat.history", who, `window ${spanLabel(before.window_s)} -> ${spanLabel(after.window_s)}`);
  if (changed.includes("search") && (before.search !== false) !== (after.search !== false)) await rooms.event(id, "chat.search", who, after.search !== false ? "on" : "off");
  if (changed.includes("downloads")) await rooms.event(id, "chat.downloads", who, after.downloads == null ? "default" : after.downloads ? "on" : "off");
  if (changed.includes("mods_all")) await rooms.event(id, "chat.mods", who, after.mods_all ? "all history" : "7 days past the window");
  // 📜 the pad's chat says what visitors now get (the effective chat window: the setting, capped by the tier)
  const B = require("./bridge");
  if (changed.includes("window_s") && effBefore.chat !== effAfter.chat) await B.noteItem(id, { w: "window", s: effAfter.chat }).catch(() => false);
  if ((before.search !== false) !== (after.search !== false)) await B.noteItem(id, { w: "search", s: after.search !== false }).catch(() => false);
  B.refreshRoom(id);
  return state(id, actor);
}

/** "Also open earlier history…": takes effect 7 days later, announced now (📜 line; Pepe from the owner sync) and at effect. */
async function openEarlier(actor, R, scope) {
  await CL.init();
  await mustManage(actor, R);
  mustUnlocked(actor, R.id);
  const lim = limit(actor, R.id);
  if (lim) throw new Refuse(429, lim, "rate");
  const CV = require("./chatlogview");
  let op;
  try { op = await CV.requestOpen(R.id, String(scope || ""), actor.userId); } catch (e) { if (e.refuse) throw new Refuse(e.status, e.message, e.code); throw e; }
  await require("./rooms").event(R.id, "chat.open_earlier", actor.username || actor.userId || "?",
                                 `requested (${op.scope}), takes effect ${new Date(op.effective).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  const B = require("./bridge");
  await B.noteItem(R.id, { w: "open", o: op.effective, sc: op.scope }).catch(() => false);
  B.refreshRoom(R.id);
  return state(R.id, actor);
}
async function cancelEarlier(actor, R) {
  await CL.init();
  await mustManage(actor, R);
  mustUnlocked(actor, R.id);
  const CV = require("./chatlogview");
  if (!(await CV.cancelOpen(R.id))) throw new Refuse(404, "Nothing is scheduled.", "none");
  await require("./rooms").event(R.id, "chat.open_earlier", actor.username || actor.userId || "?", "cancelled");
  require("./bridge").refreshRoom(R.id);
  return state(R.id, actor);
}

/** A site admin locks (or unlocks) a pad's chat settings. -> {locked} */
async function setLock(actor, R, locked) {
  await CL.init();
  if (!SP.can(actor, LOCK_CAP)) throw new Refuse(403, "Site admins only.", "admin_only");
  if (!R || !R.id) throw new Refuse(404, "No such pad.", "no_pad");
  const cur = await rawRow(R.id);
  if (cur.locked === !!locked) return { locked: !!locked };
  await writeRow(R.id, Object.assign({}, cur, { locked: !!locked }), actor.userId);
  await require("./rooms").event(R.id, "chat.lock", actor.username || actor.userId || "?", locked ? "locked" : "unlocked");
  return { locked: !!locked };
}

/** The admin card's per-pad list: every pad with a settings row. */
function adminRows() {
  let rooms = null;
  try { rooms = require("./rooms"); } catch (e) { rooms = null; }
  const CV = require("./chatlogview");
  return CL.padCfgIds().slice(0, 300).map((id) => {
    const c = CL.padCfg(id), R = rooms ? rooms.getCached(id) : null, eff = CL.effectiveWindows(id);
    const W = CV._rows.get(id) || null;
    return { room_id: id, title: R ? R.title : null, slug: R ? R.slug : null, window_s: c.window_s, chat_s: eff.chat, tx_s: eff.tx,
             search: c.search !== false, downloads: c.downloads, mods_all: !!c.mods_all, locked: c.locked, updated: c.updated,
             wm: W ? { chat: W.wm_chat, tx: W.wm_tx, search: W.wm_search, aud_m: W.aud_m, exp_chat: W.exp_chat, exp_tx: W.exp_tx } : null,
             open: CV.pendingOpen(id) ? { scope: CV.pendingOpen(id).scope, effective: Number(CV.pendingOpen(id).effective) } : null };
  });
}

function register(app, { addUser }) {
  const express = require("express");
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "2kb" });
  const head = (res) => res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" });
  const bad = (res, st, error, code) => res.status(st).json({ ok: false, error, ...(code ? { code } : {}) });
  const fail = (res, e) => {
    if (e && e.refuse) return bad(res, e.status || 400, e.message, e.code);
    console.error("[padchat]", e);
    bad(res, 500, "Something went wrong - nothing was changed.", "error");
  };
  // writes: JSON from this site's own pages only
  const sameOrigin = (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) { bad(res, 403, "Security check failed - reload the page.", "security"); return false; }
    return true;
  };
  const account = async (req) => (req.user && req.user.userId ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0] || req.user : null);
  const pad = (slug) => require("./roomsweb").resolveRoom(slug);

  app.get("/api/rooms/:slug/chat-settings", addUser, async (req, res) => {
    head(res);
    try {
      const me = await account(req);
      const R = await pad(req.params.slug);
      await mustManage(me, R);
      res.json({ ok: true, ...(await state(R.id, me)) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/chat-settings", addUser, json, async (req, res) => {
    head(res);
    if (!sameOrigin(req, res)) return;
    try { const me = await account(req); res.json({ ok: true, ...(await save(me, await pad(req.params.slug), req.body)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/chat-settings/open-earlier", addUser, json, async (req, res) => {
    head(res);
    if (!sameOrigin(req, res)) return;
    try { const me = await account(req); res.json({ ok: true, ...(await openEarlier(me, await pad(req.params.slug), (req.body || {}).scope)) }); } catch (e) { fail(res, e); }
  });
  app.delete("/api/rooms/:slug/chat-settings/open-earlier", addUser, async (req, res) => {
    head(res);
    if (!sameOrigin(req, res)) return;
    try { const me = await account(req); res.json({ ok: true, ...(await cancelEarlier(me, await pad(req.params.slug))) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/chatlog/lock", addUser, json, async (req, res) => {
    head(res);
    if (!sameOrigin(req, res)) return;
    try {
      const me = await account(req);
      if (!me || !SP.can(me, LOCK_CAP)) return bad(res, 403, "Site admins only.", "admin_only");
      const b = req.body || {};
      const R = (await require("./rooms").get(String(b.room || ""))) || (await pad(String(b.room || "")));
      res.json({ ok: true, ...(await setLock(me, R, b.locked === true)) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, state, summary, save, openEarlier, cancelEarlier, setLock, adminRows, cleanWindow, Refuse,
  WINDOW_MIN, WINDOW_MAX, PRESETS, SET_MAX, HOUR_MAX, LOCK_CAP,
  _reset: () => HITS.clear(), _setClock: (fn) => { NOW = fn || (() => CL.now()); } };
