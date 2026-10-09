// mentions.js — 🔔 room mention alerts (1.99ii): like Telegram keyword alerts, for the Camfrog rooms Pepe bridges.
//
// A member keeps a list of words / phrases - their own names by default (PATV username, PATV display name, linked
// Camfrog login), plus up to WORDS_MAX custom ones, each for every room or one room - with quiet hours and a mute.
// When a chat line in a bridged room matches, they get a 🔔 notice (inbox.js, kind "mention": the bell in the nav)
// naming the room, the speaker and the line; opening it goes to the pad's Live tab at that line
// (/p/<slug>?tab=live&line=<cursor>, views/room.ejs highlights it while it is still in the live chat).
//
// Where the matching happens: HERE, on the bridge feed (bridge.js ingest hands each batch's new chat lines to
// onLines, which queues them and returns at once - Pepe's sync never waits on it). Decided over doing it in Pepe:
//   * the feed already carries exactly the lines the web may see: Pepe drops !incognito and `!bridge hide` users'
//     lines before anything leaves him (they arrive as "someone" with no login and the bridge keeps no such line);
//     we re-check his hidden list (quotes.isHidden) anyway
//   * the lists, quiet hours, pad visibility (padaccess) and the bell all live on the site - no extra round trip,
//     nothing new on Pepe's packet path, and no private word lists shipped to the bot
//   * the cost: one precompiled regex test per (enabled user x line), against a cached index rebuilt on change
// The catch: only BRIDGED rooms are covered - a room Pepe doesn't bridge has no feed (the settings page says so).
// Web push: the site has no push subscriptions (no service worker / VAPID), so alerts are the 🔔 only for now.
//
// Never alerted: your own lines (by your linked login), Pepe's / bots' lines, anonymised or hidden speakers, a pad
// you can't see (padaccess.full: the live room is members-tier), while muted or in your quiet hours (skipped, not
// queued). Rate-limited per user: one alert per room per ROOM_GAP_MS and HOUR_MAX an hour.
//
//   mention_prefs   user_id, enabled (0/1, default off), names (0/1: match my own names, default on),
//                   quiet_from / quiet_to (minutes after midnight in tz, both NULL = none), tz, muted_until (ms), updated
//   mention_words   user_id, phrase, room_id ('' = every room)
//
// Routes (signed in; JSON = same site + X-Requested-With: fetch)
//   GET  /settings/mentions          the settings page (views/mentions.ejs)
//   GET  /api/mentions               {prefs, words, names, rooms}
//   POST /api/mentions               save {enabled, names, words: [{phrase, room}], quiet: {from, to, tz} | null}
//   POST /api/mentions/mute          {minutes} (0 = unmute)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const WORDS_MAX = 25, PHRASE_MIN = 2, PHRASE_MAX = 60, NAME_MIN = 3;
const ROOM_GAP_MS = 60 * 1000;          // one alert per user per room per minute
const HOUR_MAX = 12;                    // and at most this many an hour
const INDEX_TTL_MS = 60 * 1000;         // the index is rebuilt at least this often (account renames, links)
const QUEUE_MAX = 500;                  // lines waiting to be matched (a burst beyond this drops the oldest)
const MUTE_MAX_MIN = 30 * 24 * 60;

let NOW = () => Date.now();
const _setClock = (fn) => { NOW = fn || (() => Date.now()); };

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS mention_prefs (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
        names INTEGER NOT NULL DEFAULT 1, quiet_from INTEGER, quiet_to INTEGER, tz TEXT, muted_until INTEGER, updated INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS mention_words (user_id TEXT NOT NULL, phrase TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (user_id, phrase, room_id))`);
    })().catch((e) => { console.error("[mentions] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// ── text helpers ──
const cleanPhrase = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]+/g, " ")
  .replace(/\s+/g, " ").trim().slice(0, PHRASE_MAX);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A whole-word, case-insensitive matcher for a phrase ("bob" matches "hey Bob!" but not "bobby"). */
function matcher(phrase) {
  const p = cleanPhrase(phrase);
  if (p.length < PHRASE_MIN) return null;
  const body = p.split(" ").map(escRe).join("\\s+");
  try { return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu"); } catch (e) { return null; }
}
function validTz(tz) {
  const t = String(tz || "").slice(0, 64);
  if (!t) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: t }); return t; } catch (e) { return null; }
}
/** Minutes after midnight at `ms` in `tz` (UTC when unknown). */
function minuteOfDay(ms, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: validTz(tz) || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
    const h = Number((parts.find((p) => p.type === "hour") || {}).value), m = Number((parts.find((p) => p.type === "minute") || {}).value);
    return ((h % 24) * 60 + m) % 1440;
  } catch (e) { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
}
/** Is `ms` inside the quiet window [from, to) (wrapping past midnight when from > to)? */
function inQuiet(ms, from, to, tz) {
  if (from == null || to == null || from === to) return false;
  const m = minuteOfDay(ms, tz);
  return from < to ? m >= from && m < to : m >= from || m < to;
}
const minutes = (v) => { if (v == null || v === "") return null; const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 && n < 1440 ? n : null; };

// ── the account's own names ──
async function accountOf(userId) {
  const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const pick = (c) => (cols.has(c) ? c : `NULL AS ${c}`);
  return (await getQuery(`SELECT userId, username, class, ${pick("displayname")}, ${pick("camfrogUsername")}, ${pick("archived_at")} FROM users WHERE userId = ?`,
    [String(userId || "")]))[0] || null;
}
/** The names matched for "my own names": PATV username, display name, linked Camfrog login (3+ characters each). */
function ownNames(acc) {
  if (!acc) return [];
  let disp = "";
  try { disp = require("./displaynames").usable(acc.displayname) || ""; } catch (e) { disp = acc.displayname || ""; }
  const out = [], seen = new Set();
  for (const n of [acc.username, disp, acc.camfrogUsername]) {
    const p = cleanPhrase(n);
    if (p.length < NAME_MIN || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out;
}

// ── settings ──
async function prefsRow(userId) {
  await init();
  return (await getQuery("SELECT * FROM mention_prefs WHERE user_id = ?", [userId]))[0] || null;
}
async function get(userId) {
  await init();
  const r = await prefsRow(userId);
  const words = await getQuery("SELECT phrase, room_id FROM mention_words WHERE user_id = ? ORDER BY rowid", [userId]);
  const acc = await accountOf(userId);
  const t = NOW();
  return {
    prefs: { enabled: !!(r && r.enabled), names: r ? !!r.names : true,
             quiet: r && r.quiet_from != null && r.quiet_to != null ? { from: r.quiet_from, to: r.quiet_to, tz: r.tz || "UTC" } : null,
             tz: (r && r.tz) || null, mutedUntil: r && r.muted_until > t ? r.muted_until : null },
    words: words.map((w) => ({ phrase: w.phrase, room: w.room_id || "" })),
    names: ownNames(acc),
    linked: !!(acc && acc.camfrogUsername),
  };
}
class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }
/** Save the whole settings form. words: [{phrase, room}] (room '' = every room; unknown rooms are refused). */
async function save(userId, { enabled, names, words, quiet } = {}, knownRooms = null) {
  await init();
  const list = [], seen = new Set();
  for (const w of (Array.isArray(words) ? words : []).slice(0, 100)) {
    const phrase = cleanPhrase(w && w.phrase);
    if (!phrase) continue;
    if (phrase.length < PHRASE_MIN) throw new Refuse(400, `"${phrase}" is too short - words need at least ${PHRASE_MIN} characters.`);
    if (!matcher(phrase)) throw new Refuse(400, `"${phrase}" can't be matched.`);
    const room = String((w && w.room) || "").slice(0, 128);
    if (room && knownRooms && !knownRooms.has(room)) throw new Refuse(400, "One of the rooms isn't a room Pepe bridges.");
    const k = phrase.toLowerCase() + "|" + room;
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ phrase, room });
  }
  if (list.length > WORDS_MAX) throw new Refuse(400, `Up to ${WORDS_MAX} words or phrases.`);
  let qf = null, qt = null, tz = null;
  if (quiet && typeof quiet === "object") {
    qf = minutes(quiet.from); qt = minutes(quiet.to); tz = validTz(quiet.tz);
    if (qf == null || qt == null) qf = qt = null;
  }
  if (!tz && quiet && typeof quiet === "object") tz = validTz(quiet.tz);
  const cur = await prefsRow(userId);
  await runQuery(`INSERT INTO mention_prefs (user_id, enabled, names, quiet_from, quiet_to, tz, muted_until, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, names = excluded.names, quiet_from = excluded.quiet_from,
                  quiet_to = excluded.quiet_to, tz = COALESCE(excluded.tz, mention_prefs.tz), updated = excluded.updated`,
                 [userId, enabled ? 1 : 0, names === false ? 0 : 1, qf, qt, tz, cur ? cur.muted_until : null, NOW()]);
  await runQuery("DELETE FROM mention_words WHERE user_id = ?", [userId]);
  for (const w of list) await runQuery("INSERT OR IGNORE INTO mention_words (user_id, phrase, room_id) VALUES (?, ?, ?)", [userId, w.phrase, w.room]);
  invalidate();
  return get(userId);
}
/** Mute for `mins` minutes (0 = unmute). */
async function mute(userId, mins) {
  await init();
  const m = Math.max(0, Math.min(MUTE_MAX_MIN, Math.floor(Number(mins) || 0)));
  const until = m ? NOW() + m * 60e3 : null;
  await runQuery(`INSERT INTO mention_prefs (user_id, muted_until, updated) VALUES (?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET muted_until = excluded.muted_until, updated = excluded.updated`, [userId, until, NOW()]);
  invalidate();
  return get(userId);
}

// ── the matching index (every enabled user's compiled words) ──
let INDEX = null;           // {at, users: [{userId, username, class, login, words: [{re, phrase, room, own}], quiet, tz, mutedUntil}]}
let building = null;
function invalidate() { INDEX = null; }
async function index() {
  if (INDEX && NOW() - INDEX.at < INDEX_TTL_MS) return INDEX;
  if (building) return building;
  building = (async () => {
    await init();
    const prefs = await getQuery("SELECT * FROM mention_prefs WHERE enabled = 1 LIMIT 5000");
    const users = [];
    for (const p of prefs) {
      const acc = await accountOf(p.user_id);
      if (!acc || acc.archived_at) continue;
      const words = [];
      if (p.names) for (const n of ownNames(acc)) { const re = matcher(n); if (re) words.push({ re, phrase: n, room: "", own: true }); }
      for (const w of await getQuery("SELECT phrase, room_id FROM mention_words WHERE user_id = ?", [p.user_id])) {
        const re = matcher(w.phrase);
        if (re) words.push({ re, phrase: w.phrase, room: w.room_id || "", own: false });
      }
      if (!words.length) continue;
      users.push({ userId: acc.userId, username: acc.username, class: acc.class, login: acc.camfrogUsername ? String(acc.camfrogUsername).toLowerCase() : null,
                   words, quiet: p.quiet_from != null && p.quiet_to != null ? [p.quiet_from, p.quiet_to] : null, tz: p.tz || null, mutedUntil: p.muted_until || 0 });
    }
    INDEX = { at: NOW(), users };
    return INDEX;
  })().finally(() => { building = null; });
  return building;
}

// ── rate limit ──
const sent = new Map();     // userId -> {rooms: Map(roomId -> ms), hour: [ms]}
function allow(userId, roomId, t) {
  let s = sent.get(userId);
  if (!s) sent.set(userId, (s = { rooms: new Map(), hour: [] }));
  s.hour = s.hour.filter((x) => t - x < 3600e3);
  if (s.hour.length >= HOUR_MAX) return false;
  if (t - (s.rooms.get(roomId) || 0) < ROOM_GAP_MS) return false;
  s.hour.push(t);
  s.rooms.set(roomId, t);
  if (sent.size > 20000) sent.clear();
  return true;
}

/** Who should be alerted for one chat line -> [{user, word}] (pure apart from the rate limit). */
function matchLine(IDX, line, t) {
  const it = line.it || {};
  const u = it.u || {};
  if (it.k !== "msg" || !it.text || !u.login || u.anon || u.self || u.bot) return [];
  const speaker = String(u.login).toLowerCase();
  let hidden = false;
  try { hidden = require("./quotes").isHidden(speaker); } catch (e) { hidden = false; }
  if (hidden) return [];
  let PA = null;
  try { PA = require("./padaccess"); } catch (e) { PA = null; }
  const out = [];
  for (const U of IDX.users) {
    if (U.login && U.login === speaker) continue;                         // your own line
    const w = U.words.find((x) => (!x.room || x.room === line.roomId) && x.re.test(it.text));
    if (!w) continue;
    if (PA && !PA.full({ userId: U.userId, class: U.class }, line.roomId)) continue;     // a pad they can't see
    if (U.mutedUntil > t) continue;
    if (U.quiet && inQuiet(t, U.quiet[0], U.quiet[1], U.tz)) continue;
    if (!allow(U.userId, line.roomId, t)) continue;
    out.push({ user: U, word: w });
  }
  return out;
}

const snip = (s, n) => { const x = String(s || "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1).trimEnd() + "…" : x; };
/** The 🔔 notice for one alert. */
function noticeFor(line, word) {
  const it = line.it, u = it.u || {};
  const who = snip(u.display || u.login || "someone", 40);
  const room = snip(line.name || line.slug || "a room", 60);
  const title = word.own ? `💬 ${who} mentioned you in ${room}` : `💬 ${who} said “${snip(word.phrase, 40)}” in ${room}`;
  const link = line.slug ? `/p/${encodeURIComponent(line.slug)}?tab=live&line=${Number(it.c) || 0}` : "/p";
  return { kind: "mention", title, body: `${who}: ${snip(it.text, 300)}`, link, ref: `mention:${line.roomId}:${Number(it.c) || it.ts || ""}` };
}

// ── the queue (bridge.js ingest -> here; never awaited by the sync) ──
const queue = [];
let running = false;
/** lines: [{roomId, slug, name, it}] - the batch's new chat lines. Returns at once. */
function onLines(lines) {
  for (const l of lines || []) if (l && l.it && l.it.k === "msg") queue.push(l);
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  if (!running && queue.length) { running = true; setImmediate(drain); }
}
async function drain() {
  try {
    while (queue.length) {
      const batch = queue.splice(0, 50);
      let IDX;
      try { IDX = await index(); } catch (e) { console.error("[mentions] index:", e.message); break; }
      if (!IDX.users.length) continue;
      const inbox = require("./inbox");
      for (const line of batch) {
        for (const m of matchLine(IDX, line, NOW())) await inbox.addSafe(m.user.userId, noticeFor(line, m.word));
      }
    }
  } finally {
    running = false;
    if (queue.length) { running = true; setImmediate(drain); }
  }
}
/** Tests: wait until the queue is empty. */
async function _idle() { while (running || queue.length) await new Promise((r) => setTimeout(r, 5)); }

// ── routes ──
function register(app, { addUser }) {
  init().catch(() => {});
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  const guard = (write) => (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (write && !req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const fail = (res, e) => {
    const st = e && e.refuse ? e.status : 500;
    if (st === 500) console.error("[mentions]", e && e.message);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  // the rooms a member can pick: the Camfrog pads Pepe bridges that they can see
  async function rooms(user) {
    let list = [];
    try { list = await require("./bridge").summary(true); } catch (e) { list = []; }
    let PA = null;
    try { PA = require("./padaccess"); await PA.init(); } catch (e) { PA = null; }
    return list.filter((r) => !PA || PA.full(user, r.id)).map((r) => ({ id: r.id, name: r.name, slug: r.slug }));
  }
  app.get("/settings/mentions", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings/mentions"));
    try {
      const boot = { ...(await get(req.user.userId)), rooms: await rooms(req.user), wordsMax: WORDS_MAX, hourMax: HOUR_MAX };
      res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      res.render("mentions", { title: "Mention alerts", user: req.user.username, boot });
    } catch (e) {
      console.error("[mentions] page:", e.message);
      res.status(500).send("Couldn't load your mention alerts.");
    }
  });
  app.get("/api/mentions", addUser, guard(false), async (req, res) => {
    try { res.json({ ok: true, ...(await get(req.user.userId)), rooms: await rooms(req.user) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/mentions", addUser, guard(true), async (req, res) => {
    try {
      const b = req.body || {};
      const known = new Set((await rooms(req.user)).map((r) => r.id));
      res.json({ ok: true, ...(await save(req.user.userId, { enabled: !!b.enabled, names: b.names !== false, words: b.words, quiet: b.quiet || null }, known)) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/mentions/mute", addUser, guard(true), async (req, res) => {
    try { res.json({ ok: true, ...(await mute(req.user.userId, (req.body || {}).minutes)) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, get, save, mute, onLines, matchLine, noticeFor, matcher, inQuiet, minuteOfDay, ownNames, index, invalidate,
                   WORDS_MAX, ROOM_GAP_MS, HOUR_MAX, _setClock, _idle, _sent: sent, Refuse };
