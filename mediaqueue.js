// mediaqueue.js — 1.99lr: 📼 QUEUES for Play from Plex. A whole season, the rest of a season, the series from an episode,
// or a hand-made list of titles, played back to back in ONE library slot on a pad's stage.
//
// HOW IT PLAYS: the site drives it. The queue opens one 📼 library slot (mainstage.libraryOpen) long enough for everything
// in it, and starts each title with a fresh `PUT /streams/<stage>` on mediactl with that slot's key - the same seamless
// restart a seek already is (the RTMP publish drops for a few seconds between titles; the slot, its HLS / WHEP / Twitch
// relay and its viewers stay). The watcher (medialib.watch, every 10 s, plus a one-off timer timed for the end of the
// title) sees mediactl report a title `ended` and starts the next one. Per title: the slot's title ("📼 Show — S2E5
// Title": the stage, the homepage's now playing, the pad's live info) and the session/play rows; the starter's quality,
// audio and subtitle choice carry over, matched by LANGUAGE (an English track on the next episode, whatever its index).
// Holds its slot + its encoder between titles (medialib.busyOf); one library stream per pad (medialib.preflight).
//
// WHO + MONEY (medialib.access):
//   * Plex members / the override list / admins + staff: FREE for the whole queue. A queue is ONE play towards the daily
//     caps (library_free_daily_cap / library_daily_cap), however many titles it holds.
//   * everyone else: library_price per STARTED HOUR, charged AS IT PLAYS. Before each title starts:
//       hours needed = ceil((seconds actually played so far + what's left of this title) / 3600), at least 1;
//       anything above the hours already paid is charged now (shop.chargeService hold: held until that title is on the
//       stage, routed like any play - flow library_play - refunded if it never gets there). So a title is never cut
//       mid-way for money, and a skipped title only costs what was played of it.
//     The estimate (every title's hours, rounded up once) is shown and confirmed up front; nothing past the first title is
//     taken until it plays. Out of PAT for the next title = the queue ends after the current one, with a notice
//     ("you're out of PAT - top up to keep watching": the Go-live page + an inbox notice).
// LIMITS: library_queue_max_items titles, library_queue_max_hours hours (what's left of every title); the pause timeout
//   (a paused slot ends after library_pause_max_min) and the site-wide stream cap apply as for one title.
// ROBUSTNESS: a title that fails (mediactl `error`, not playable) is logged (its play row) and skipped; 3 in a row end the
//   queue. mediactl restarted (the stream's gone) -> the same title again where it was, with a fresh key. The queue lives
//   in media_queues, so a site restart picks it up (the slot gets a fresh key: mainstage.libraryRekey). An encoder that's
//   busy / unreachable between titles is retried for RETRY_MS.
// ANNOUNCEMENTS: the first title is the stream start (golive.js: followers once + the pad). Each next title: the slot's
//   title always; Pepe's "📼 Now playing on <pad>: <title>" (the pad's chat + its Camfrog room, golive.nowPlaying) only
//   library_queue_announce_min after the last announcement (no spam for short episodes), and never a second go-live alert.
// CONTROLS (the starter + the library admins): next / previous / pause / resume / seek / stop, and what's left: remove,
//   move, add. /stage (Your slot), the pad page's Go-live card, /admin/media.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const conf = require("./mediaconf");
const stage = require("./mainstage");
const rooms = require("./rooms");

const L = () => require("./medialib");
const I = () => require("./medialib")._q;

const SCOPES = ["episode", "season_rest", "season", "series_from", "series", "list"];
const RETRY_MS = 5 * 60 * 1000;     // no free encoder between two titles: keep trying this long
const MAX_FAILS = 3;                // titles in a row that never got going -> the queue ends
const MAX_RESTARTS = 5;             // the same title lost this many times (mediactl restarting) -> the queue ends
const RECENT_MS = 15 * 60 * 1000;   // an ended queue still shows (with why) this long
const FAST_WINDOW = 15;             // a title this close to its end gets a one-off watch timed for its end
const AFTER_MAX = 5;                // upnext3 (1.99ali): people lined up after what's on, at most (each one's own queue: lineFor)

let NOW = () => Date.now();
function _setClock(fn) { NOW = fn || (() => Date.now()); }
const refuse = (status, msg, extra) => new (L().Refuse)(status, msg, extra);

// ── pure: building a queue ──
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const validKey = (k) => /^\d{1,12}$/.test(String(k == null ? "" : k));
/** One title as a queue keeps it. */
function slim(it) {
  return { key: String(it.key), type: it.type === "movie" ? "movie" : "episode", title: String(it.title || "").slice(0, 200),
           show: it.show ? String(it.show).slice(0, 120) : null, season: num(it.season), episode: num(it.episode),
           year: num(it.year), duration: Math.max(0, Math.round(Number(it.duration) || 0)) };
}
/** Episodes in watching order: season, then episode (Plex's allLeaves order kept for ties). */
function sortEps(eps) {
  return (eps || []).map((e, i) => ({ e, i })).filter((x) => x.e && x.e.type === "episode" && validKey(x.e.key))
    .sort((a, b) => ((num(a.e.season) || 0) - (num(b.e.season) || 0)) || ((num(a.e.episode) || 0) - (num(b.e.episode) || 0)) || (a.i - b.i))
    .map((x) => x.e);
}
const noSpecials = (eps) => { const r = eps.filter((e) => (num(e.season) || 0) !== 0); return r.length ? r : eps; };
/**
 * A show's episodes -> the queue for `scope` from `anchor` (an episode; null = the whole series).
 *   episode       just it
 *   season_rest   its season from it on
 *   season        its whole season
 *   series_from   the series from it on (specials - season 0 - only when it is one)
 *   series        every episode but the specials
 */
function buildQueue(episodes, anchor, scope) {
  const eps = sortEps(episodes);
  if (!anchor) return noSpecials(eps).map(slim);
  const key = String(anchor.key);
  const i = eps.findIndex((e) => String(e.key) === key);
  if (scope === "episode" || i < 0) return [slim(anchor)];
  const season = num(eps[i].season) || 0;
  if (scope === "season_rest") return eps.slice(i).filter((e) => (num(e.season) || 0) === season).map(slim);
  if (scope === "season") return eps.filter((e) => (num(e.season) || 0) === season).map(slim);
  if (scope === "series_from") return eps.slice(i).filter((e) => season === 0 || (num(e.season) || 0) !== 0).map(slim);
  if (scope === "series") return noSpecials(eps).map(slim);
  return [slim(anchor)];
}
/** The seconds a queue plays: what's left of the first title (from `offset`) + every other title. */
function totalSec(items, offset = 0) {
  return (items || []).reduce((t, it, i) => t + Math.max(0, (Number(it.duration) || 0) - (i === 0 ? Math.max(0, Number(offset) || 0) : 0)), 0);
}
/** Keep at most maxItems titles and maxSec seconds (the first title always stays). -> {items, total_sec, truncated} */
function capQueue(items, offset, { maxItems, maxSec }) {
  const out = [];
  let t = 0;
  for (const it of items || []) {
    const d = Math.max(0, (Number(it.duration) || 0) - (out.length === 0 ? Math.max(0, Number(offset) || 0) : 0));
    if (out.length && (out.length >= maxItems || t + d > maxSec)) break;
    out.push(it);
    t += d;
  }
  return { items: out, total_sec: t, truncated: out.length < (items || []).length };
}
/** The up-front estimate: every title's time, rounded up to started hours once. */
const estimate = (perHour, sec) => (perHour > 0 && sec > 0 ? perHour * Math.max(1, Math.ceil(sec / 3600)) : 0);
/** Started hours needed once a title (from `offset`) has played on top of `playedSec`. */
const hoursNeeded = (playedSec, dur, offset) => Math.max(1, Math.ceil((Math.max(0, playedSec) + Math.max(0, (Number(dur) || 0) - Math.max(0, offset || 0))) / 3600));
/** The starter's choice as languages (from the first title's tracks). */
function prefsFrom(it, o) {
  const a = o.audio == null ? null : (it.audio || []).find((x) => x.index === o.audio);
  const s = o.sub == null ? null : (it.subs || []).find((x) => x.index === o.sub);
  return { quality: o.quality, audio_lang: a ? a.lang || null : null, audio_label: a ? a.label || null : null,
           sub_on: !!s, sub_lang: s ? s.lang || null : null, sub_label: s ? s.label || null : null, sub_forced: !!(s && s.forced), sub_image: !!(s && s.image) };
}
/** The same choice on another title, matched by language (then by label); nothing that matches = its default / none. */
function pickTracks(it, P = {}) {
  let audio = null, sub = null;
  const auds = it.audio || [];
  if (P.audio_lang || P.audio_label) {
    const c = auds.filter((a) => (P.audio_lang ? a.lang === P.audio_lang : a.label === P.audio_label));
    c.sort((x, y) => (/comment/i.test(x.label || "") - /comment/i.test(y.label || "")) || ((y.default ? 1 : 0) - (x.default ? 1 : 0)));
    if (c.length) audio = c[0].index;
  }
  if (P.sub_on) {
    const c = (it.subs || []).filter((s) => s.burnable && (P.sub_lang ? s.lang === P.sub_lang : s.label === P.sub_label));
    c.sort((x, y) => ((x.forced === !!P.sub_forced ? 0 : 1) - (y.forced === !!P.sub_forced ? 0 : 1)) || ((x.image ? 1 : 0) - (y.image ? 1 : 0)));
    if (c.length) sub = c[0].index;
  }
  return { audio, sub };
}

// ── storage ──
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch (e) { return d; } };
async function load(id) {
  const r = (await getQuery("SELECT * FROM media_queues WHERE id = ?", [id]))[0];
  if (!r) return null;
  return { ...r, items: parse(r.items, []), prefs: parse(r.prefs, {}), brk: parse(r.brk, null) };   // (upnext2: brk = its station break)
}
async function activeFor(roomId) {
  const r = (await getQuery("SELECT id FROM media_queues WHERE room_id = ? AND state = 'active' ORDER BY id DESC LIMIT 1", [String(roomId || "")]))[0];
  return r ? load(r.id) : null;
}
async function forRoomOf(room) {
  await L().init();
  const R = await I().roomOf(room);
  return R ? activeFor(R.id) : null;
}
const saveItems = (q) => runQuery("UPDATE media_queues SET items = ?, updated = ? WHERE id = ?", [JSON.stringify(q.items), NOW(), q.id]);
async function playOf(id) { return (await getQuery("SELECT * FROM media_plays WHERE id = ?", [id]))[0] || null; }

// one change at a time per pad (the watcher and the controls)
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

// ── building one from a request ──
async function build(b, S, capSec = Infinity) {
  const maxItems = S.library_queue_max_items || 60, maxSec = Math.min((S.library_queue_max_hours || 12) * 3600, capSec);
  const offset = Math.max(0, Math.floor(Number(b.offset) || 0));
  let items = [], scope = "list", first = null;
  if (Array.isArray(b.keys) && b.keys.length) {
    const keys = b.keys.map(String).filter(validKey).slice(0, maxItems);
    if (!keys.length) throw refuse(400, "Pick something to play.");
    for (const k of keys) {
      const it = await I().fetchItem(k);
      if (!it) continue;
      if (it.type === "movie" || it.type === "episode") { if (!items.length) first = it; items.push(slim(it)); }
      else if (it.type === "show" || it.type === "season") items.push(...buildQueue(it.episodes, null, "series"));
      if (items.length >= maxItems) break;
    }
  } else {
    if (!validKey(b.key)) throw refuse(400, "Bad item.");
    scope = SCOPES.includes(b.scope) ? b.scope : "episode";
    const it = await I().fetchItem(b.key);
    if (!it) throw refuse(404, "Not in the Plex library.");
    if (it.type === "show" || it.type === "season") { items = buildQueue(it.episodes, null, "series"); scope = it.type === "show" ? "series" : "season"; }
    else if (it.type === "movie" || (it.type === "episode" && scope === "episode")) { items = [slim(it)]; first = it; }
    else if (it.type === "episode") {
      if (!it.show_key) throw refuse(409, "Season and series queues need media-control 1.4.0 - ask an admin to update it.");
      const show = await I().fetchItem(it.show_key);
      items = buildQueue((show && show.episodes) || [], it, scope);
      if (items.length && items[0].key === String(it.key)) first = it;
    } else throw refuse(400, "Pick a movie, an episode or a show.");
  }
  if (!items.length) throw refuse(400, "There's nothing to play in that.");
  const capped = capQueue(items, offset, { maxItems, maxSec });
  return { ...capped, scope, offset, first };
}

function priceView(A, S, sec) {
  const per = A.free ? 0 : Math.max(0, Math.floor(Number(S.library_price) || 0));
  return { per_hour: per, estimate: estimate(per, sec), hours: per ? Math.max(1, Math.ceil(sec / 3600)) : 0, free: !per };
}
/** What a queue would hold and cost (nothing is opened or charged). */
// 1.99lw: a pad's 📼 limit (mainstage.libraryMaxFor: the owner's longest slot, else 6 h) as seconds of content
const BOOK_BUFFER_MIN = 5;              // a booked 📼 slot = its runtime + this
async function padCapSec(room, forBooking) {
  if (!room) return Infinity;
  const R = await I().roomOf(room).catch(() => null);
  if (!R) return Infinity;
  const lim = await stage.limitsFor(R.id);
  return Math.max(60, (lim.library_max - (forBooking ? BOOK_BUFFER_MIN : I().SLACK_MIN)) * 60);
}
const bookMinutes = (sec) => Math.ceil(sec / 60) + BOOK_BUFFER_MIN;
/** What a queue would hold and cost (nothing is opened or charged). b.when = "later": sized for a booked slot. */
async function preview(user, b = {}) {
  await L().init();
  const A = await I().mustAccess(user);
  const S = conf.get();
  const single = !Array.isArray(b.keys) && (!b.scope || b.scope === "episode");
  if (S.library_queue === false && !(single && b.when === "later")) throw refuse(403, "Queues are switched off right now.", { code: "queue_off" });
  const later = b.when === "later";
  const q = await build(b, S, await padCapSec(b.room, later));
  const first = q.items[0];
  const firstHours = A.free ? 0 : hoursNeeded(0, first.duration, q.offset);
  const pv = priceView(A, S, q.total_sec);
  return { ok: true, items: q.items, total_sec: q.total_sec, truncated: q.truncated, scope: q.scope, ...pv,
           first_charge: pv.per_hour * firstHours, max_items: S.library_queue_max_items, max_hours: S.library_queue_max_hours,
           slot_minutes: later ? bookMinutes(q.total_sec) : null };
}

// ── playing ──
const fmtTitle = (it) => L().fmtTitle(it);
const stageName = (roomId) => L().stageName(roomId);
const padTitle = async (roomId) => { const R = await I().roomOf(roomId).catch(() => null); return (R && R.title) || roomId; };

/**
 * Start title `i` of queue `q` (inside the pad's lock). Charges what it needs first (non-members), then mediactl.
 * Throws: e.outOfPat (402), e.slotGone, e.busy (no encoder now: try again), anything else = this title won't play.
 */
async function startTitle(q, i, { offset = 0, item = null, tracks = null } = {}) {
  const ref = q.items[i];
  if (!ref) throw refuse(400, "No such title in the queue.");
  // (upnext3 review, money: Plex / media-control answering 5xx or unreachable = try this title again - goTo's busy path - never a skip)
  const it = item || await I().fetchItem(ref.key).catch((e) => { if (e && [429, 502, 503].includes(e.status)) e.busy = true; throw e; });
  if (!it || !["movie", "episode"].includes(it.type) || !it.file) throw refuse(400, "That title has no playable file.");
  const slot = await stage.getSlot(q.slot_id);
  if (!slot || slot.settled || !["waiting", "active"].includes(slot.status)) throw Object.assign(refuse(409, "The queue's slot has ended."), { slotGone: true });
  // upnext (owner 2026-11-05): the stage says what's coming up next from the moment the queue moves on, until this title's first frame (the
  // same title retried - no free encoder yet - keeps its first moment: mainstage.libraryUpNext)
  await stage.libraryUpNext(q.slot_id, L().upNextInfo(it)).catch((e) => console.error("[mediaqueue] up next:", e.message));
  // a free encoder before any money moves (our own stage doesn't count)
  const name = stageName(q.room_id);
  const live = await I().streamsNow();
  if (live === null) throw Object.assign(refuse(503, "The Plex player can't be reached right now."), { busy: true });
  const busy = live.filter((x) => x.state === "playing" && x.stage !== name).length;
  if (live.max && busy >= live.max) throw Object.assign(refuse(429, "Every library stream is in use right now."), { busy: true });
  const off = Math.max(0, Math.min(Math.floor(Number(offset) || 0), Math.max(0, (it.duration || 0) - 30)));
  const tr = tracks || pickTracks(it, q.prefs);
  const quality = [1080, 720, 480].includes(Number(q.prefs.quality)) ? Number(q.prefs.quality) : conf.get().library_quality;
  const title = fmtTitle(it);
  // the money: started hours of what's actually been played + this title, above what's paid
  let order = null, hours = 0, price = 0;
  if (q.per_hour > 0) {
    hours = Math.max(0, hoursNeeded(q.played_sec, it.duration, off) - q.paid_hours);
    if (hours > 0) {
      price = hours * q.per_hour;
      try {
        order = await require("./shop").chargeService({ userId: q.user_id, username: q.username, price, source: "medialib", hold: true,
          title: `📼 Play from Plex (queue): ${title} on ${await padTitle(q.room_id)}`,
          note: `${hours} more started hour${hours === 1 ? "" : "s"} × ${I().fmtPat(q.per_hour)} PAT - held until it's on the stage, refunded if it never gets there` });
      } catch (e) {
        if (e && e.status === 402) { e.outOfPat = true; e.need = price; }
        throw e;
      }
      await runQuery("UPDATE media_queues SET paid_hours = paid_hours + ? WHERE id = ?", [hours, q.id]);
      q.paid_hours += hours;
    }
  }
  const undo = async (why) => {
    if (!order) return;
    const back = await require("./shop").refundService(order.order_id, "📼 " + String(why || "it didn't start").slice(0, 120), "system").catch(() => false);
    if (back) { await runQuery("UPDATE media_queues SET paid_hours = MAX(0, paid_hours - ?) WHERE id = ?", [hours, q.id]); q.paid_hours = Math.max(0, q.paid_hours - hours); }
    else console.error(`[mediaqueue] queue #${q.id}: order ${order.order_id} NOT refunded after a failed start - check it by hand`);
  };
  try {
    let key = L()._keys.get(q.room_id);
    if (!key) {
      key = await stage.libraryRekey(q.slot_id);                 // the site restarted: the raw key was only in memory
      if (!key) throw Object.assign(refuse(409, "The queue's slot has ended."), { slotGone: true });
      L()._keys.set(q.room_id, key);
    }
    await I().must("PUT", `/streams/${encodeURIComponent(name)}`, { rtmp: stage.RTMP_PUBLIC, key, ratingKey: String(it.key), offset: off, quality,
                                                                    audio: tr.audio, sub: tr.sub, title });
  } catch (e) {
    // upnext2 review (safety F12, 1.99alc): 409 "already playing" THIS title on our stage = an earlier start of ours got there (the site restarted
    // while it was on its way and the watcher asked again) - inside the pad's lock nothing else starts it: it plays, its charge stays
    if (!(e && e.status === 409 && !e.slotGone && (await I().encoderHas(q.room_id, it.key)))) {
      await undo(e.message);
      if (e && (e.status === 429 || e.status === 503)) e.busy = true;
      throw e;
    }
  }
  await stage.libraryRetitle(q.slot_id, "📼 " + title);
  const left = Math.max(0, (it.duration || 0) - off) + totalSec(q.items.slice(i + 1));
  await stage.libraryExtend(q.slot_id, Math.ceil(((slot.live_ms || 0) / 1000 + left) / 60) + I().SLACK_MIN).catch(() => {});
  const t = NOW();
  const charge = order ? "held" : q.per_hour > 0 ? "covered" : "free";
  const p = await runQuery(`INSERT INTO media_plays (ts, user_id, username, room_id, slot_id, rating_key, title, kind, year, duration, quality, offset_start, audio, sub,
                              price, order_id, charge, carried_from, access, queue_id, queue_pos, hours)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
                           [t, q.user_id, q.username, q.room_id, q.slot_id, String(it.key), title, it.type, it.year || null, it.duration || null,
                            quality, off, tr.audio, tr.sub, price, order ? order.order_id : null, charge, q.access, q.id, i, hours]);
  require("./plexpad").noteItem(it).catch(() => {});                   // 1.99nj: its metadata for the 📼 pad achievements
  await runQuery("DELETE FROM media_sessions WHERE room_id = ?", [q.room_id]);
  await runQuery(`INSERT INTO media_sessions (room_id, slot_id, play_id, rating_key, title, state, by_user, started, updated, position, duration, queue_id, live, ep_offset)
                  VALUES (?, ?, ?, ?, ?, 'playing', ?, ?, ?, ?, ?, ?, 0, ?)`,
                 [q.room_id, q.slot_id, p.id, String(it.key), title, q.username, t, t, off, it.duration || null, q.id, off]);
  await runQuery("UPDATE media_queues SET pos = ?, updated = ?, retry_since = NULL, brk = NULL WHERE id = ?", [i, t, q.id]);
  q.pos = i; q.brk = null;
  // 1.99lr: keep the stored title fresh (a show renamed in Plex, a list item that was only a key)
  if (q.items[i]) { q.items[i] = { ...q.items[i], ...slim(it) }; await saveItems(q); }
  console.log(`[mediaqueue] queue #${q.id} on ${q.room_id}: ${i + 1}/${q.items.length} "${title}" (${it.key}) at ${off}s - play #${p.id}` +
              (price ? `, ${price} PAT held (order ${order.order_id})` : ""));
  return { title, price, play_id: p.id, pos: i };
}

/** The current title's session is over (inside the lock): close its play, settle its charge, count what was played. */
async function finishTitle(q, s, how, { pos = null, error = null, by = null } = {}) {
  const p = (await playOf(s.play_id)) || {};
  const start = s.ep_offset != null ? s.ep_offset : (p.offset_start || 0);
  const dur = s.duration || p.duration || 0;
  const at = pos != null ? Number(pos) : (s.position || start);
  const played = how === "finished" ? Math.max(0, dur - start) : Math.max(0, Math.min(dur || Infinity, at) - start);
  const slot = await stage.getSlot(q.slot_id).catch(() => null);
  const wentLive = !!(slot && slot.went_live) && (!!s.live || how === "finished" || played > 2);
  const reason = how === "finished" ? "finished" : how === "error" ? "error" : `${how}${by ? " by " + by : ""}`;
  await runQuery("DELETE FROM media_sessions WHERE room_id = ? AND play_id = ?", [s.room_id, s.play_id]);
  await I().closePlay(s.play_id, reason, at, error);
  const r = await L().settle(s.play_id, wentLive, reason).catch((e) => { console.error("[mediaqueue] settle:", conf.errLine(e)); return null; });
  if (r === "refunded" && p.hours) {
    await runQuery("UPDATE media_queues SET paid_hours = MAX(0, paid_hours - ?) WHERE id = ?", [p.hours, q.id]);
    q.paid_hours = Math.max(0, q.paid_hours - p.hours);
  }
  if (wentLive && played > 0) {
    await runQuery("UPDATE media_queues SET played_sec = played_sec + ? WHERE id = ?", [Math.round(played), q.id]);
    q.played_sec += Math.round(played);
  }
  return { wentLive, played };
}

async function stopEncoder(roomId) {
  try { const r = await I().must("POST", `/streams/${encodeURIComponent(stageName(roomId))}/stop`, {}); return r.stream ? r.stream.position : null; }
  catch (e) { return null; }
}

/** End a queue (inside the lock): the current title, the slot, the row. plexreplace: slotDone = its slot already ended (a ▶ "Play this
 *  instead" took it over - mainstage.libraryOpen opts.replace); how = what the current title's play row says ("stopped" / "replaced"). */
async function endQueue(q, reason, { notice = null, by = "system", stageReason = null, slotDone = false, how = "stopped" } = {}) {
  const s = await I().session(q.room_id);
  if (s && Number(s.queue_id) === Number(q.id)) {
    const pos = await stopEncoder(q.room_id);
    await finishTitle(q, s, how, { pos: pos != null ? pos : s.position, by: by === "system" ? null : by });
  } else {
    try { await I().call("POST", `/streams/${encodeURIComponent(stageName(q.room_id))}/stop`, {}); } catch (e) { /* best effort */ }
  }
  if (!slotDone) await stage.end(q.slot_id, stageReason || (reason === "finished" ? "library_done" : "library_stopped"), by).catch(() => {});
  await runQuery("UPDATE media_queues SET state = 'ended', ended_at = ?, end_reason = ?, notice = ?, updated = ? WHERE id = ? AND state IN ('active','starting')",
                 [NOW(), String(reason || "ended").slice(0, 120), notice, NOW(), q.id]);
  q.state = "ended";
  L()._keys.delete(q.room_id);
  console.log(`[mediaqueue] queue #${q.id} on ${q.room_id} ended: ${reason}`);
}

/** Start title `i`, else the next one that will (inside the lock). Never throws. upnext2: a title change takes the pad's station break first
 *  (beginBreak: the marker now, the title when it's over - breakDue); noBreak = the break was had already (it's due, a retry for an encoder,
 *  the site restarted between two titles). tracks = the starter's audio / subtitle pick for title `i` (a queue's first title). */
async function goTo(q, i, { offset = 0, noBreak = false, tracks = null } = {}) {
  if (!conf.on.library()) {
    await endQueue(q, "Play from Plex was switched off");
    await cancelLine(q.room_id, "Play from Plex was switched off");                   // (upnext3: nothing starts after it either)
    return { ended: true };
  }
  let brk = !noBreak;
  while (i >= 0 && i < q.items.length) {
    await runQuery("UPDATE media_queues SET pos = ?, updated = ? WHERE id = ?", [i, NOW(), q.id]);
    q.pos = i;
    // (upnext3: whoever is lined up after it takes the stage over - endOrHand)
    if (q.fails >= MAX_FAILS) { await endOrHand(q, `${q.fails} titles in a row didn't play`, { notice: "failed", stageReason: "library_error" }); return { ended: true }; }
    if (brk) {
      brk = false;
      // upnext3 (1.99ali, item 10): a booked 📼 start that came due waits for the title that was on - this title change is its moment: it
      // plays now and this queue carries on right after it, from title i (yieldToBooking)
      const y = await yieldToBooking(q, i, { offset, tracks });
      if (y) return y;
      const secs = await L().breakSec(q.room_id).catch(() => 0);
      const b = secs > 0 ? await beginBreak(q, i, secs, { offset, tracks }).catch((e) => { console.error("[mediaqueue] break:", conf.errLine(e)); return null; }) : null;
      if (b) return b;
    }
    try {
      const r = await startTitle(q, i, { offset, tracks });
      await announce(q, r.title).catch(() => {});      // never throws; quick (a DB row + the bridge)
      return { ok: true, ...r };
    } catch (e) {
      if (e && e.outOfPat) {
        const prev = q.items[i - 1];
        await endOrHand(q, "out of PAT", { notice: "out_of_pat", stageReason: "library_done" });
        outOfPatNotice(q, prev ? fmtTitle(prev) : null, e.need).catch(() => {});
        return { ended: true, out_of_pat: true };
      }
      if (e && e.slotGone) { await endQueue(q, "the slot ended"); await afterEnded(q.room_id, q.slot_id); return { ended: true }; }
      if (e && e.busy) {
        await runQuery("UPDATE media_queues SET retry_since = COALESCE(retry_since, ?), updated = ? WHERE id = ?", [NOW(), NOW(), q.id]);
        console.warn(`[mediaqueue] queue #${q.id}: title ${i + 1} waits for an encoder (${conf.errLine(e)})`);
        return { waiting: true };
      }
      // this title won't play: logged, skipped
      console.warn(`[mediaqueue] queue #${q.id}: title ${i + 1} (${(q.items[i] || {}).key}) didn't start - skipped: ${conf.errLine(e)}`);
      const ref = q.items[i] || {};
      await runQuery(`INSERT INTO media_plays (ts, user_id, username, room_id, slot_id, rating_key, title, kind, duration, price, charge, access, queue_id, queue_pos,
                        ended_at, end_reason, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'none', ?, ?, ?, ?, 'skipped: didn''t start', ?)`,
                     [NOW(), q.user_id, q.username, q.room_id, q.slot_id, ref.key || null, ref.key ? fmtTitle(ref) : null, ref.type || null, ref.duration || null,
                      q.access, q.id, i, NOW(), String(e.message || e).slice(0, 300)]).catch(() => {});
      await runQuery("UPDATE media_queues SET fails = fails + 1 WHERE id = ?", [q.id]);
      q.fails++;
      i++;
      offset = 0;
      tracks = null;
    }
  }
  await endOrHand(q, "finished");
  return { ended: true, finished: true };
}

// ── upnext2: the 📼 STATION BREAK between two titles (medialib.js has the whole story) ──
/** (inside the lock) Title `i` comes up after a break of `secs`: the stage's "Coming up next" marker now, the title itself at `until`
 *  (breakDue - its timer, or the watcher). Nothing is charged and no encoder starts during it; the queue keeps its slot and its encoder.
 *  -> {ok, break, until, title, pos, price: 0} | null (no break: the slot is gone or the title can't play - goTo starts / skips it as before) */
async function beginBreak(q, i, secs, { offset = 0, tracks = null, item = null } = {}) {
  const ref = q.items[i];
  if (!ref || !(secs > 0)) return null;
  const slot = await stage.getSlot(q.slot_id);
  if (!slot || slot.settled || !["waiting", "active"].includes(slot.status)) return null;
  const it = item || await I().fetchItem(ref.key).catch(() => null);
  if (!it || !["movie", "episode"].includes(it.type) || !it.file) return null;
  const until = NOW() + secs * 1000;
  const b = { until, pos: i, offset: Math.max(0, Math.floor(Number(offset) || 0)), tracks: tracks ? { audio: tracks.audio == null ? null : tracks.audio, sub: tracks.sub == null ? null : tracks.sub } : null };
  await runQuery("UPDATE media_queues SET pos = ?, brk = ?, updated = ? WHERE id = ?", [i, JSON.stringify(b), NOW(), q.id]);
  q.pos = i; q.brk = b;
  await stage.libraryUpNext(q.slot_id, L().upNextInfo(it)).catch((e) => console.error("[mediaqueue] up next:", e.message));
  L().armBreak(q.room_id, until);
  console.log(`[mediaqueue] queue #${q.id} on ${q.room_id}: ${i + 1}/${q.items.length} "${fmtTitle(it)}" after a ${secs} s station break`);
  return { ok: true, break: true, until, starts_at: until, title: fmtTitle(it), pos: i, price: 0 };
}
/** A queue's station break may be over: its title starts (the pad's lock; only the break the queue still has - ⏭ / ⏮ set a newer one,
 *  ⏹ / a replace ended the queue). -> started something? */
async function breakDue(roomId) {
  return withLock(String(roomId), async () => {
    const q = await activeFor(roomId);
    if (!q || !q.brk) return false;
    const b = q.brk;
    if (await I().session(q.room_id)) {                                  // (a title is on: this break is stale)
      await runQuery("UPDATE media_queues SET brk = NULL WHERE id = ?", [q.id]);
      return false;
    }
    if (Number(b.until) > NOW() + 50) { L().armBreak(q.room_id, Number(b.until)); return false; }
    return startAfterBreak(q, b);
  });
}
/** (inside the lock) The break `b` is over: title b.pos starts (goTo without a second break - a title that won't start is skipped as ever) */
async function startAfterBreak(q, b) {
  await runQuery("UPDATE media_queues SET brk = NULL WHERE id = ?", [q.id]);
  q.brk = null;
  const slot = await stage.getSlot(q.slot_id);
  if (!slot || slot.settled || slot.status === "ended") { await endQueue(q, "slot " + ((slot && slot.end_reason) || "ended")); await afterEnded(q.room_id, q.slot_id); return true; }
  const pos = Number.isInteger(Number(b.pos)) && Number(b.pos) >= 0 ? Number(b.pos) : q.pos;
  await goTo(q, pos, { offset: Number(b.offset) || 0, tracks: b.tracks || null, noBreak: true });
  return true;
}

async function outOfPatNotice(q, after, need) {
  const pad = await padTitle(q.room_id);
  await require("./inbox").addSafe(q.user_id, { kind: "media", title: "📼 You're out of PAT - top up to keep watching",
    body: `Your queue on ${pad} ended${after ? ` after ${after}` : ""}: the next title needs ${I().fmtPat(need || q.per_hour)} PAT.`,
    link: "/wallet", ref: "mlibq-pat:" + q.id });
}

// ── announcements: the next title (the first is the stream start: golive.js) ──
async function announce(q, title) {
  const gap = Math.max(0, Number(conf.get().library_queue_announce_min) || 0) * 60000;
  const t = NOW();
  // claim it first: two titles in a row never both announce inside the gap
  const c = await runQuery("UPDATE media_queues SET last_announce = ? WHERE id = ? AND (last_announce IS NULL OR ? - last_announce >= ?)", [t, q.id, t, gap]);
  if (!c || !c.changes) return { announced: false, why: "gap" };
  q.last_announce = t;
  const u = (await getQuery("SELECT displayname FROM users WHERE userId = ?", [q.user_id]))[0];
  return require("./golive").nowPlaying({ roomId: q.room_id, userId: q.user_id, display: (u && u.displayname) || q.username, what: title });
}

// ── the watcher (medialib.watch hands every queue session here) ──
let fastOn = false;
const fast = new Map();
function fastWatch(roomId, inSec) {
  if (!fastOn || fast.has(roomId)) return;
  const h = setTimeout(() => { fast.delete(roomId); L().watch(roomId).catch(() => {}); }, Math.max(1, inSec + 1.5) * 1000);
  if (h.unref) h.unref();
  fast.set(roomId, h);
}
/** One look at a queue's title. -> changed something? */
function onWatch(s0, slot, m, live) {
  return withLock(s0.room_id, async () => {
    const s = await I().session(s0.room_id);
    if (!s || s.play_id !== s0.play_id) return false;                 // a control moved it on meanwhile
    const q = await load(s.queue_id);
    if (q && q.state === "starting") return false;                     // its first title is being started right now
    if (!q || q.state !== "active") {                                  // its queue is gone: just the title
      await stopEncoder(s.room_id);
      await finishTitle(q || { id: s.queue_id, slot_id: s.slot_id, paid_hours: 0, played_sec: 0 }, s, "stopped");
      return true;
    }
    if (!slot || slot.settled || slot.status === "ended") {
      await endQueue(q, "slot " + ((slot && slot.end_reason) || "ended"));
      await afterEnded(q.room_id, q.slot_id);                          // (upnext3: a Cut of this slot - what's lined up starts; a cleared stage - it doesn't)
      return true;
    }
    if (live === null) return false;                                   // can't see mediactl right now: change nothing
    if (m && String(m.ratingKey) !== String(s.rating_key)) m = undefined;
    if (!m) {
      if (s.state === "paused" && NOW() - s.updated < 60000) return false;
      // mediactl lost it (restarted): the same title again where it was
      if (q.restarts >= MAX_RESTARTS) { await endOrHand(q, "lost (media-control keeps restarting)", { stageReason: "library_lost" }); return true; }
      await runQuery("UPDATE media_queues SET restarts = restarts + 1 WHERE id = ?", [q.id]);
      q.restarts++;
      try { await resumeTitle(q, s, s.position != null ? s.position : (s.ep_offset || 0)); }
      catch (e) {
        if (!(e && (e.status === 429 || e.status === 503 || e.status === 502))) { await advance(q, s, "error", { error: conf.errLine(e) }); }
      }
      return true;
    }
    const progressed = (m.state === "playing" && Number(m.position) > Number(m.offset) + 1) || m.state === "ended";
    if (!s.live && progressed && slot.went_live) {
      await runQuery("UPDATE media_sessions SET live = 1 WHERE room_id = ? AND play_id = ?", [s.room_id, s.play_id]);
      await runQuery("UPDATE media_queues SET fails = 0, restarts = 0 WHERE id = ?", [q.id]);
      q.fails = 0;
      s.live = 1;
      await L().settle(s.play_id, true).catch((e) => console.error("[mediaqueue] settle:", conf.errLine(e)));
    }
    if (m.state === "ended") { await advance(q, s, "finished", { pos: m.position }); return true; }
    if (m.state === "error") {
      // 1.99acx: right after a seek / next / previous (the new encoder can collide with the one it replaced on the ingest -
      // medialib.retryRestart): once more, not a skip
      if (await I().retryRestart(s, m, live && live.look)) return true;
      if (!s.live) { await runQuery("UPDATE media_queues SET fails = fails + 1 WHERE id = ?", [q.id]); q.fails++; }
      console.warn(`[mediaqueue] queue #${q.id}: "${s.title}" failed (${m.error || "error"}) - skipping to the next`);
      await advance(q, s, "error", { pos: m.position, error: m.error });
      return true;
    }
    await runQuery("UPDATE media_sessions SET position = ?, state = ?, updated = ? WHERE room_id = ? AND play_id = ?",
                   [m.position, m.state === "paused" ? "paused" : "playing", NOW(), s.room_id, s.play_id]);
    if (m.state === "playing" && s.duration && s.duration - m.position <= FAST_WINDOW) fastWatch(s.room_id, Math.max(0, s.duration - m.position));
    return false;
  });
}
/** The current title is done (inside the lock): close it, then the next (or `to`). */
async function advance(q, s, how, opts = {}) {
  await finishTitle(q, s, how, opts);
  const next = opts.to != null ? opts.to : how === "prev" ? q.pos - 1 : q.pos + 1;
  return goTo(q, next);
}
/** The same title again at `pos` on the same slot (mediactl forgot it), with a fresh key when the site forgot it too. */
async function resumeTitle(q, s, pos) {
  const p = (await playOf(s.play_id)) || {};
  let key = L()._keys.get(q.room_id);
  if (!key) {
    key = await stage.libraryRekey(q.slot_id);
    if (!key) throw refuse(409, "The queue's slot has ended.");
    L()._keys.set(q.room_id, key);
  }
  const off = Math.max(0, Math.floor(Number(pos) || 0));
  await I().must("PUT", `/streams/${encodeURIComponent(stageName(q.room_id))}`, { rtmp: stage.RTMP_PUBLIC, key, ratingKey: String(s.rating_key), offset: off,
    quality: p.quality || conf.get().library_quality, audio: p.audio, sub: p.sub, title: s.title });
  await runQuery("UPDATE media_sessions SET state = 'playing', position = ?, updated = ? WHERE room_id = ? AND play_id = ?", [off, NOW(), s.room_id, s.play_id]);
  console.log(`[mediaqueue] queue #${q.id}: "${s.title}" started again at ${off}s (media-control had lost it)`);
  return { ok: true, position: off };
}
// (plexreplace review fix: medialib's resume / seek now run under the pad's lock themselves - {locked: true}, never a second wait on it)
function restartCurrent(s, pos, _by = null, { locked = false } = {}) {
  const run = async () => {
    const q = await load(s.queue_id);
    if (!q || q.state !== "active") throw refuse(404, "This queue has ended.");
    return resumeTitle(q, s, pos);
  };
  return locked ? run() : withLock(s.room_id, run);
}
/** Active queues with no title on (waiting for an encoder, or the site stopped between two titles). */
async function watchIdle() {
  await L().init();
  // 1.99lw: booked 📼 slots whose time came
  await watchBookings().catch((e) => console.error("[mediaqueue] bookings:", conf.errLine(e)));
  // a start that never finished (the process died half-way): close it so the pad is free again
  for (const r of await getQuery("SELECT id, room_id FROM media_queues WHERE state = 'starting' AND updated < ?", [NOW() - 2 * 60000])) {
    await withLock(r.room_id, async () => {
      const q = await load(r.id);
      if (q && q.state === "starting") { await endQueue(q, "didn't finish starting", { stageReason: "library_failed" }); await afterEnded(q.room_id, q.slot_id); }
    }).catch((e) => console.error("[mediaqueue] stale start:", conf.errLine(e)));
  }
  // upnext3 (1.99ali): a pad's 📼 line - handed over at once whenever the stage frees up (handOver, under the pad's lock); here only what a
  // site restart or a busy media-control left (lineLook), and the waits' caps
  for (const r of await getQuery("SELECT DISTINCT room_id FROM media_queues WHERE state = 'after'")) {
    await withLock(r.room_id, () => lineLook(r.room_id)).catch((e) => console.error("[mediaqueue] line:", conf.errLine(e)));
  }
  const qs = await getQuery(`SELECT id, room_id FROM media_queues q WHERE state = 'active'
                             AND NOT EXISTS (SELECT 1 FROM media_sessions s WHERE s.room_id = q.room_id)`);
  let n = 0;
  for (const r of qs) {
    await withLock(r.room_id, async () => {
      const q = await load(r.id);
      if (!q || q.state !== "active" || (await I().session(q.room_id))) return;
      const slot = await stage.getSlot(q.slot_id);
      if (!slot || slot.settled || slot.status === "ended") { await endQueue(q, "slot " + ((slot && slot.end_reason) || "ended")); await afterEnded(q.room_id, q.slot_id); n++; return; }
      // upnext2: in its station break - nothing until it's over; one that is due starts now (its timer was lost: a restart)
      if (q.brk) { if (Number(q.brk.until) > NOW()) return; await startAfterBreak(q, q.brk); n++; return; }
      if (q.retry_since && NOW() - q.retry_since > RETRY_MS) {
        await endQueue(q, "no free encoder", { notice: "no_encoder" });
        // (upnext3: the encoders are the site's - none for the picks lined up either; review money 5: a paused queue keeps its place - its own cap)
        await cancelLine(q.room_id, "no library stream came free in time", { kinds: ["after"] });
        n++; return;
      }
      await goTo(q, q.pos, { noBreak: true });                         // (upnext2: an encoder retry / a restart between titles - had its break)
      n++;
    }).catch((e) => console.error("[mediaqueue] idle:", conf.errLine(e)));
  }
  return n;
}

// ── starting one ──
async function start(user, b = {}) {
  await L().init();
  const A = await I().mustAccess(user);
  const S = conf.get();
  if (S.library_queue === false) throw refuse(403, "Queues are switched off right now.", { code: "queue_off" });
  const R = await I().roomOf(b.room);
  if (!R) throw refuse(404, "No such pad.", { code: "pad" });
  return withLock(R.id, () => launch(user, A, R, b, null));
}
/** 1.99ajk plexchat: the pad's visibility (seesPad) then start() - the ONE entry point (the /stage route, Pepe's chat, the Room Dock). */
async function startFor(user, b = {}) {
  const body = { ...(b || {}) };
  const R = await I().roomOf(body.room);
  if (body.room && R && !(await stage.seesPad(user && user.userId ? user : null, R.id))) throw refuse(404, "No such pad.", { code: "pad" });
  return start(user, body);
}
/** 1.99ajk plexchat: the same for a booking (Go-live's "Later"). */
async function bookFor(user, b = {}) {
  const body = { ...(b || {}) };
  const R = await I().roomOf(body.room);
  if (body.room && R && !(await stage.seesPad(user && user.userId ? user : null, R.id))) throw refuse(404, "No such pad.", { code: "pad" });
  return book(user, body);
}
/**
 * (inside the pad's lock) Build, check, open the slot - or, for a booking, open ITS slot (mainstage.libraryActivate) -
 * and start the first title. booked = {slot_id} for a booked slot's start: its estimate was confirmed when it was booked.
 */
// upnext2 (E): sys = {rep, reason} - an after-queue taking the stage over from the title it waited behind, which ended by itself (startAfter):
// no permission over that title is needed (nobody's title comes off), its slot ends `reason` (library_done / library_error)
async function launch(user, A, R, b, booked, sys = {}) {
  const S = conf.get();
  {
    // plexreplace: {replace: true} - this queue takes over from what's on (medialib.replaceTarget: you may control it, else control_denied);
    // every refusal below comes first, the old title stops only once the new slot exists (medialib.retire)
    const rep = sys.rep || (!booked && I().wantsReplace(b) ? await I().replaceTarget(user, R, I().replaceWant(b)) : null);
    // (upnext3: sys.system = a hand-over - the stage is this one's turn; booked = a booking's own start: neither is refused booking_next)
    await I().preflight(user, A, R, { replacing: rep, system: !!sys.system, booking: !!booked });
    const built = await build(b, S, await padCapSec(R.id, !!booked));
    const pv = priceView(A, S, built.total_sec);
    // upnext3 review (money 3, 1.99ali): a booking's start checks the estimate its booker said yes to when they booked it (media_bookings.estimate
    // - 0 = it was free then): a price rise while it waited never charges more - it doesn't start (bookingFailed words this refusal as the notice)
    if (pv.estimate > 0 && booked) {
      const said = Math.max(0, Math.floor(Number(booked.estimate) || 0));
      if (!(pv.estimate <= said)) {
        throw refuse(409, `It costs about ${I().fmtPat(pv.estimate)} points now - ${said ? `more than the ${I().fmtPat(said)} points you said yes to when you booked it` : "it was free when you booked it"}. Book it again to play it.`,
                     { estimate: pv.estimate, code: "estimate" });
      }
    }
    if (pv.estimate > 0 && !booked) {
      if (b.estimate == null || b.estimate === "") throw refuse(400, `This queue costs about ${I().fmtPat(pv.estimate)} PAT as it plays - confirm it to start.`, { estimate: pv.estimate, code: "estimate" });
      // upnext2 review (function F3 / safety F5, 1.99alc): titles added behind a single title start later (sys.after) - what they cost now may be
      // LESS than the figure their owner said yes to (a price drop, a pad limit that cut one), never more
      const said = Math.floor(Number(b.estimate));
      if (sys.after ? !(pv.estimate <= said) : said !== pv.estimate) throw refuse(409, `The estimate is ${I().fmtPat(pv.estimate)} PAT now - confirm it again.`, { estimate: pv.estimate, code: "estimate" });
    }
    // upnext2 review (safety F2, 1.99alc): a paid queue's first hour is charged when its first title starts - after the station break. Without the
    // points for it, it is refused NOW, as a ▶ Play's charge is at the press (it took the pad's stage for the break and then ended "out of
    // PAT", again and again, never counted on the daily cap)
    if (pv.per_hour > 0) {
      const need = pv.per_hour * hoursNeeded(0, built.items[0].duration, built.offset), have = await balanceOf(user.userId);
      if (have < need) {
        throw Object.assign(refuse(402, `Starting it takes ${I().fmtPat(need)} PAT (its first title's started hours) and you have ${I().fmtPat(have)} - top up first.`,
                                   { code: "pat", need, balance: have }), { outOfPat: true, need });   // (a booking's notice: "out of PAT")
      }
    }
    // upnext2: the station break on this pad (the card now, the first title when it's over). review (safety F11): a queue that takes one asks
    // for a free encoder too, a library admin's free one included (it holds it through the break)
    const secs = await L().breakSec(R.id).catch(() => 0);
    if (!I().isLibAdmin(user) || pv.per_hour > 0 || secs > 0) await I().needEncoder(rep ? R.id : null);
    const first = built.first && String(built.first.key) === built.items[0].key ? built.first : await I().fetchItem(built.items[0].key);
    if (!first || !["movie", "episode"].includes(first.type) || !first.file) throw refuse(400, "The first title has no playable file.", { code: "bad" });
    const o = {
      quality: [1080, 720, 480].includes(Number(b.quality)) ? Number(b.quality) : S.library_quality,
      audio: b.audio !== undefined && b.audio !== null && b.audio !== "" && (first.audio || []).some((a) => a.index === Number(b.audio)) ? Number(b.audio) : null,
      sub: b.sub !== undefined && b.sub !== null && b.sub !== "" && (first.subs || []).some((x) => x.index === Number(b.sub) && x.burnable) ? Number(b.sub) : null,
    };
    const prefs = prefsFrom(first, o);
    let opened;
    if (booked) {
      // upnext3 (item 10): a booking that waited for the title on the pad takes its slot over (sys.rep: the feature + the card carry)
      const key = await stage.libraryActivate(booked.slot_id, { title: "📼 " + fmtTitle(first), minutes: Math.ceil(built.total_sec / 60) + I().SLACK_MIN,
        ...(rep ? { replace: rep.slot_id, reason: sys.reason || "library_done", upnext: L().upNextInfo(first), actor: sys.actor || null } : {}) });
      const sl = await stage.getSlot(booked.slot_id);
      opened = { key, slot: { id: sl.id, stream: sl.stream, hls: null } };
      if (rep) await I().retire(user, R, rep, sl.id);
    } else {
      opened = await stage.libraryOpen(user, { room: R.id, title: "📼 " + fmtTitle(first),
                                               minutes: Math.min(24 * 60, Math.ceil(built.total_sec / 60) + I().SLACK_MIN),
                                               ...(rep ? { replace: rep.slot_id, upnext: L().upNextInfo(first), ...(sys.reason ? { reason: sys.reason } : {}),
                                                           ...(sys.actor ? { actor: sys.actor } : {}) } : {}) });
      if (rep) await I().retire(user, R, rep, opened.slot.id);      // (the old encoder off, its play / queue closed - before this key is kept;
                                                                     //  upnext3: what's lined up behind it waits behind this one now)
    }
    L()._keys.set(R.id, opened.key);
    const t = NOW();
    const ins = await runQuery(`INSERT INTO media_queues (room_id, user_id, username, access, state, items, pos, prefs, scope, per_hour, paid_hours, played_sec,
                                  slot_id, created, updated, last_announce) VALUES (?, ?, ?, ?, 'starting', ?, 0, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
                               [R.id, user.userId, user.username, A.how, JSON.stringify(built.items), JSON.stringify(prefs), built.scope, pv.per_hour,
                                opened.slot.id, t, t, t]);
    // upnext3: the line's row that this is - used up now (a restart from here on finds the queue, never the row again: never two starts)
    if (sys.afterId) await runQuery("UPDATE media_queues SET state = 'started', end_reason = ?, updated = ? WHERE id = ? AND state = 'after'", [`started as queue #${ins.id}`, t, sys.afterId]);
    // upnext3 review (money 6): a booking likewise - 'started' with its queue now, not after its first title went out (a restart between left it
    // 'waiting': a "didn't start" notice for a stream that played, and yieldToBooking couldn't tell its queue was a booked one)
    let bkWas = null;
    if (booked) {
      bkWas = ((await getQuery("SELECT state FROM media_bookings WHERE slot_id = ?", [booked.slot_id]))[0] || {}).state || null;
      await runQuery("UPDATE media_bookings SET state = 'started', queue_id = ?, updated = ? WHERE slot_id = ? AND state IN ('booked','waiting')", [ins.id, t, booked.slot_id]);
    }
    const q = await load(ins.id);
    let r;
    try {
      // upnext2: the station break first (the card now, the first title when it's over - its charge is taken then, by startTitle)
      r = secs > 0 ? await beginBreak(q, 0, secs, { offset: built.offset, item: first, tracks: { audio: o.audio, sub: o.sub } }) : null;
      if (!r) r = await startTitle(q, 0, { offset: built.offset, item: first, tracks: { audio: o.audio, sub: o.sub } });
      // 'starting' until now: a watcher (this process or another one on the same DB) leaves a queue alone while it starts
      await runQuery("UPDATE media_queues SET state = 'active', updated = ? WHERE id = ? AND state = 'starting'", [NOW(), q.id]);
    } catch (e) {
      // the first title didn't start: nothing stays open, any charge already came back (startTitle)
      await stage.end(opened.slot.id, "library_failed", user.username).catch(() => {});
      await runQuery("UPDATE media_queues SET state = 'ended', ended_at = ?, end_reason = ? WHERE id = ?", [NOW(), "didn't start: " + String(e.message || "error").slice(0, 100), q.id]);
      L()._keys.delete(R.id);
      // (upnext3: the line's row waits again - the hand-over cancels it with this reason, a notice to its owner)
      if (sys.afterId) await runQuery("UPDATE media_queues SET state = 'after', end_reason = NULL WHERE id = ? AND state = 'started'", [sys.afterId]).catch(() => {});
      // (review money 6: the booking too - its watcher / the hand-over fails it with this reason, or tries again)
      if (booked && ["booked", "waiting"].includes(bkWas)) {
        await runQuery("UPDATE media_bookings SET state = ?, queue_id = NULL WHERE slot_id = ? AND state = 'started' AND queue_id = ?", [bkWas, booked.slot_id, q.id]).catch(() => {});
      }
      throw e;
    }
    if (rep && !sys.rep) await I().logControl(user, R.id, "replace", `${rep.title || "?"} → ${r.title}`, { play_id: r.play_id, queue_id: q.id });
    console.log(`[mediaqueue] ${user.username} (${A.how}) queued ${built.items.length} titles (${built.scope}, ${Math.round(built.total_sec / 60)} min) on ${R.id} - queue #${q.id}` +
                (pv.per_hour ? `, est. ${pv.estimate} PAT` : ", free") + (rep ? ` - replaced "${rep.title}"${rep.q ? ` (queue #${rep.q.id})` : ""} on slot ${rep.slot_id}` : ""));
    return { ok: true, queue_id: q.id, slot: { id: opened.slot.id, stream: opened.slot.stream, hls: opened.slot.hls }, title: r.title, price: r.price,
             ...(r.break ? { starts_at: r.until } : {}),                   // (upnext2: its station break)
             items: built.items.length, total_sec: built.total_sec, truncated: built.truncated, estimate: pv.estimate, per_hour: pv.per_hour,
             ...(rep ? { replaced: { title: rep.title || null, queue: !!rep.q, slot_id: rep.slot_id, feature: opened.replaced ? opened.replaced.carried || null : null } } : {}) };
  }
}

// ── 1.99lw: BOOKING a 📼 Plex slot for later (the Go-live page's "Later" in 📼 mode) ──
// A booked slot is an ordinary scheduled stage slot (mainstage.book {library}: the schedule, clashes, approval, the
// per-user limits), sized to the runtime: one title or the queue + BOOK_BUFFER_MIN, under the pad's 📼 limit and the
// queue limits. No slot fee and nothing taken now: the play's own rules apply when it starts (free for Plex members /
// admins / staff; others pay per started hour as it plays). At its start time the watcher (watchBookings) starts it like
// ▶ Play would; can't (out of PAT, no Plex access any more, the daily cap, media-control down / every encoder busy
// for the start window) = the slot ends unstarted + a notice (and any hold - none today - comes back with the slot).
//   media_bookings   slot_id -> who, what (the request), state booked | started | failed | cancelled
let bkReady = null;
function bookingsInit() {
  if (!bkReady) {
    bkReady = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS media_bookings (slot_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT,
        req TEXT NOT NULL, start_at INTEGER NOT NULL, minutes INTEGER, items INTEGER, estimate INTEGER, state TEXT NOT NULL, queue_id INTEGER, error TEXT,
        created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS media_bookings_state ON media_bookings (state, start_at)");
      // upnext2 (D): the booking's first title (slim) - "COMING UP AT <time> · <title>" and the off-air slate name it
      // upnext3 (1.99ali): state 'waiting' = its time came while a library title was on the pad - it starts when that title ends (wait_since:
      // since when, wait_for: the title it waits for, free_at: when the stage came free for it - a busy media-control's retry window)
      for (const def of ["first TEXT", "wait_since INTEGER", "wait_for TEXT", "free_at INTEGER"]) {
        try { await runQuery(`ALTER TABLE media_bookings ADD COLUMN ${def}`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
    })().catch((e) => { bkReady = null; throw e; });
  }
  return bkReady;
}
async function book(user, b = {}) {
  await L().init();
  await bookingsInit();
  const A = await I().mustAccess(user);
  const S = conf.get();
  const R = await I().roomOf(b.room);
  if (!R) throw refuse(404, "No such pad.");
  const single = !Array.isArray(b.keys) && (!b.scope || b.scope === "episode");
  if (S.library_queue === false && !single) throw refuse(403, "Queues are switched off right now.");
  const built = await build(b, S, await padCapSec(R.id, true));
  const pv = priceView(A, S, built.total_sec);
  if (pv.estimate > 0) {
    if (b.estimate == null || b.estimate === "") throw refuse(400, `This costs about ${I().fmtPat(pv.estimate)} PAT as it plays - confirm it to book.`, { estimate: pv.estimate });
    if (Math.floor(Number(b.estimate)) !== pv.estimate) throw refuse(409, `The estimate is ${I().fmtPat(pv.estimate)} PAT now - confirm it again.`, { estimate: pv.estimate });
  }
  const minutes = bookMinutes(built.total_sec);
  const first = built.items[0];
  const title = "📼 " + fmtTitle(first) + (built.items.length > 1 ? ` +${built.items.length - 1}` : "");
  const r = await stage.book(user, { room: R.id, minutes, library: true, start_at: Number(b.start_at) || 0, title });
  const req = { key: b.key || null, scope: b.scope || null, keys: Array.isArray(b.keys) ? b.keys.map(String).filter(validKey).slice(0, 200) : null,
                offset: built.offset, quality: b.quality, audio: b.audio, sub: b.sub };
  const t = NOW();
  await runQuery(`INSERT INTO media_bookings (slot_id, room_id, user_id, username, req, start_at, minutes, items, estimate, state, created, updated, first)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?)`,
                 [r.slot.id, R.id, user.userId, user.username, JSON.stringify(req), r.slot.start_at, minutes, built.items.length, pv.estimate, t, t,
                  first ? JSON.stringify(first) : null]);
  console.log(`[mediaqueue] ${user.username} booked 📼 ${built.items.length} title(s), ${minutes} min on ${R.id} for ${new Date(r.slot.start_at).toISOString()} (slot ${r.slot.id})`);
  return { ok: true, slot: r.slot, minutes, items: built.items.length, total_sec: built.total_sec, truncated: built.truncated, estimate: pv.estimate,
           status: r.slot.status, title };
}
async function bookingFailed(bk, why0, slotEnd = true) {
  const why = points(why0);                                             // (review ux 13: a notice says points, the refusal it quotes too)
  const c = await runQuery("UPDATE media_bookings SET state = 'failed', error = ?, updated = ? WHERE slot_id = ? AND state IN ('booked','waiting')", [String(why).slice(0, 200), NOW(), bk.slot_id]);
  if (!(c && c.changes)) return false;                                  // (upnext3: once - the hand-over and the watcher may both see it)
  if (slotEnd) await stage.end(bk.slot_id, "library_failed", "system").catch(() => {});
  const pad = await padTitle(bk.room_id);
  await require("./inbox").addSafe(bk.user_id, { kind: "media", title: `📼 Your booked Plex stream on ${pad} didn't start`,
    body: String(why).slice(0, 200), link: "/stage", ref: "mlibbook-fail:" + bk.slot_id });
  console.warn(`[mediaqueue] booking ${bk.slot_id} on ${bk.room_id} didn't start: ${why}`);
  try { stage.stageBump(bk.room_id); } catch (e) { /* the 2 s cache */ }
  return true;
}
/** Booked 📼 slots whose time came: start them (called by watchIdle every tick). */
// upnext3 (1.99ali, owner 2026-11-07: "Wait for that to finish."): a booking whose time comes while something from the library is on the pad (a
// title, its station break, a queue) WAITS (state 'waiting', its booker told once): it plays right after the title on now (handOver when a
// single title / a queue ends, yieldToBooking at a queue's next title change: the rest of that queue carries on after it), never cutting a
// title. It waits at most the pad's 📼 limit after its time (no title is longer: only pauses / seeks back / chained bookings get near it) -
// then it fails like any booking that couldn't start (a notice; nothing was ever taken). Another booked queue on the pad is never cut short.
/** (inside the lock) the booking's time came with `title` on the pad: it waits for it - once: its booker is told, the pages too */
async function bookingWaits(bk, title, cap, { booked = false } = {}) {
  const t = NOW();
  const c = await runQuery("UPDATE media_bookings SET state = 'waiting', wait_since = ?, wait_for = ?, updated = ? WHERE slot_id = ? AND state = 'booked'",
                           [t, title ? String(title).replace(/^📼\s*/, "").slice(0, 120) : null, t, bk.slot_id]);
  if (!(c && c.changes)) return false;
  const pad = await padTitle(bk.room_id);
  const hrs = Math.max(1, Math.round((cap - Number(bk.start_at)) / 3600000));
  await require("./inbox").addSafe(bk.user_id, { kind: "media", title: `📼 Your booked Plex stream on ${pad} waits for the current title to finish`,
    body: (booked ? `A booked stream${title ? ` (“${String(title).replace(/^📼\s*/, "")}”)` : ""} is still on - yours starts when it ends`
                  : `${title ? `“${String(title).replace(/^📼\s*/, "")}” is still on` : "Something from the library is still on"} - yours starts right after it`) +
          ` (it can wait up to ${hrs} h after its time). Nothing is taken until it starts.`,
    link: "/stage", ref: "mlibbook-wait:" + bk.slot_id });
  console.log(`[mediaqueue] booking ${bk.slot_id} on ${bk.room_id} waits for "${title || "?"}" (until ${new Date(cap).toISOString()} at most)`);
  try { stage.stageBump(bk.room_id); } catch (e) { /* the 2 s cache */ }
  return true;
}
async function bookingWaitCap(bk) {
  const lim = await stage.limitsFor(bk.room_id).catch(() => ({ library_max: 360 }));
  return Number(bk.start_at) + (Number(lim.library_max) || 360) * 60000;
}
async function watchBookings() {
  await bookingsInit();
  const rows = await getQuery("SELECT * FROM media_bookings WHERE (state = 'booked' AND start_at <= ?) OR state = 'waiting'", [NOW()]);
  let n = 0;
  for (const bk of rows) {
    await withLock(bk.room_id, async () => {
      const cur = (await getQuery("SELECT * FROM media_bookings WHERE slot_id = ? AND state IN ('booked','waiting')", [bk.slot_id]))[0];
      if (!cur) return;
      const slot = await stage.getSlot(bk.slot_id);
      if (!slot || slot.settled || slot.status === "ended") {
        await runQuery("UPDATE media_bookings SET state = 'cancelled', updated = ? WHERE slot_id = ?", [NOW(), bk.slot_id]);
        // (upnext3: one that waited, or that nobody started in time, says so - a booker who cancelled it themselves knows: review ux 11 - a waiting
        // one too, /api/stage/slots/:id/end by its booker = 'cancelled')
        if ((cur.state === "waiting" && !(slot && slot.end_reason === "cancelled")) || (slot && ["no_room", "never_live", "library_failed"].includes(slot.end_reason))) {
          const pad = await padTitle(bk.room_id);
          await require("./inbox").addSafe(bk.user_id, { kind: "media", title: `📼 Your booked Plex stream on ${pad} didn't start`,
            body: `Its slot ended before it could start (${(slot && slot.end_reason) || "ended"}) - nothing was taken.`, link: "/stage", ref: "mlibbook-fail:" + bk.slot_id });
        }
        return;
      }
      if (slot.status === "requested") return;                          // waiting for the pad owner's OK (mainstage expires it)
      if (slot.status !== "scheduled") return;
      const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [bk.user_id]))[0];
      if (!u) { await bookingFailed(bk, "The account is gone."); n++; return; }
      const A = await L().access(u);
      if (!A.ok) { await bookingFailed(bk, A.message || "Playing from Plex isn't open right now."); n++; return; }
      const R = await I().roomOf(bk.room_id);
      if (!R) { await bookingFailed(bk, "The pad is gone."); n++; return; }
      // upnext3: something from the library is on the pad (a title, its break, a queue - or one starting): it waits for it, at most its cap
      const on = await I().onNow(R);
      const starting = (await getQuery("SELECT 1 FROM media_queues WHERE room_id = ? AND state = 'starting' LIMIT 1", [R.id]))[0];
      if (on || starting) {
        const cap = await bookingWaitCap(cur);
        if (NOW() > cap) { await bookingFailed(cur, `What was playing on the pad didn't finish in time (it may wait ${Math.round((cap - cur.start_at) / 60000)} minutes after its time).`); n++; return; }
        // (review ux 13: behind another BOOKED stream it waits for that whole stream - its notice says so)
        const bookedOn = !!(on && !on.busy && on.q && (await getQuery("SELECT 1 FROM media_bookings WHERE queue_id = ? LIMIT 1", [on.q.id]))[0]);
        if (cur.state === "booked") await bookingWaits(cur, on && !on.busy ? on.title : null, cap, { booked: bookedOn });
        // (review money 2: the stage isn't free - a start window from an earlier moment never carries over to when it is)
        if (cur.free_at) await runQuery("UPDATE media_bookings SET free_at = NULL WHERE slot_id = ?", [cur.slot_id]);
        return;
      }
      const head = (await lineFor(R.id))[0];
      if (head && head.kind === "booking" && head.bk.slot_id !== cur.slot_id) return;      // (an earlier booking goes first)
      if (!cur.free_at) { await runQuery("UPDATE media_bookings SET free_at = ? WHERE slot_id = ?", [NOW(), cur.slot_id]); cur.free_at = NOW(); }
      try {
        const r = await startHead(R, { kind: "booking", bk: cur, user_id: cur.user_id }, null, { reason: "library_done" });
        await lineBehind(R.id, r.slot_id);                                // (anyone lined up waits behind it)
        console.log(`[mediaqueue] booking ${bk.slot_id} started as queue #${r.queue_id}`);
      } catch (e) {
        const windowMs = (stage.config().start_window_min || 10) * 60000;
        const sl = await stage.getSlot(bk.slot_id).catch(() => null);
        const stillBooked = sl && sl.status === "scheduled" && !sl.settled;
        // no free encoder / unreachable: try again next tick - for the start window from when the stage came free for it (upnext3: a booking
        // that waited gets its window then, not from its booked time)
        if (transientErr(e) && stillBooked && NOW() - Math.max(Number(cur.start_at), Number(cur.free_at) || 0) < windowMs) return;
        await bookingFailed(cur, e && e.outOfPat ? "You're out of points - top up to keep watching." : (e && e.message) || "It couldn't start.");
      }
      n++;
    }).catch((e) => console.error("[mediaqueue] booking:", conf.errLine(e)));
  }
  return n;
}

// ── controls ──
async function needQueue(user, room) {
  await L().init();
  if (!user || !user.userId) throw refuse(401, "Sign in first.", { code: "signin" });
  const R = await I().roomOf(room);
  if (!R) throw refuse(404, "No such pad.", { code: "pad" });
  const q = await activeFor(R.id);
  if (!q) throw refuse(404, "There's no queue playing on this pad.", { code: "nothing_on" });
  if (!(await canControl(user, q))) throw refuse(403, I().CONTROL_DENIED, { code: "control_denied" });
  return { R, q };
}
// 1.99lw: the starter, the library admins, the pad's owner (+ site staff) - medialib.mayControl
const canControl = (user, q) => I().mayControl(user, q.room_id, q.user_id);

// ── 1.99ajk plexchat: growing a running queue (Pepe's "queue the matrix next", ⏭ past the last episode) ──
/** May `user` add titles to queue `q`? Its STARTER (the queue bills them as each title plays), or a library admin on a FREE
 *  queue (per_hour 0 - nobody is billed). Never on someone else's PAT. 1.99ajk plexchat review: the pad's owner / site staff (other
 *  controllers) no longer may - a non-member could play any title free behind a member's free queue, counted on nobody's cap. */
async function mayGrow(user, q) {
  if (!user || !user.userId || !q) return false;
  if (q.user_id && q.user_id === user.userId) return true;
  return !(Number(q.per_hour) > 0) && !!I().isLibAdmin(user);
}
/** What adding `secs` of titles after what's on adds to a running queue's bill (its per-hour rate, started hours on top of what's
 *  paid - view()'s est_left before / after). 0 on a free queue. s = the pad's session (or null). */
function addCost(q, s, secs) {
  if (!q || !(Number(q.per_hour) > 0)) return 0;
  const mine = s && Number(s.queue_id) === Number(q.id) ? s : null;
  const cur = q.items[q.pos] || null;
  const curFull = mine ? Math.max(0, (mine.duration || 0) - (mine.ep_offset || 0)) : cur ? cur.duration : 0;
  const base = q.played_sec + curFull + totalSec(q.items.slice(q.pos + 1));
  const before = Math.max(0, Math.ceil(base / 3600) - q.paid_hours);
  const after = Math.max(0, Math.ceil((base + Math.max(0, Number(secs) || 0)) / 3600) - q.paid_hours);
  return Math.max(0, after - before) * q.per_hour;
}
/** 1.99ajk plexchat: what `secs` of titles would add to the pad's running queue (null: no queue) - Pepe's "queue it next" price. */
async function addCostFor(roomId, secs) {
  const q = await activeFor(roomId);
  if (!q) return null;
  return addCost(q, await I().session(roomId), secs);
}
/** The show's next episode after `cur` (Plex's allLeaves in watching order, specials skipped unless `cur` is one) -> a slim
 *  title, or null (a movie, the last episode, an older mediactl without show_key). */
async function nextEpisodeOf(cur) {
  if (!cur || cur.type !== "episode" || !validKey(cur.key)) return null;
  const it = await I().fetchItem(cur.key);
  if (!it || !it.show_key) return null;
  const show = await I().fetchItem(it.show_key);
  const eps = sortEps((show && show.episodes) || []);
  const i = eps.findIndex((e) => String(e.key) === String(cur.key));
  if (i < 0) return null;
  const special = (num(eps[i].season) || 0) === 0;
  const after = eps.slice(i + 1).filter((e) => special || (num(e.season) || 0) !== 0);
  return after.length ? slim(after[0]) : null;
}
/**
 * "Play this next" on a pad's running 📼 queue: `keys` go right after the title on now (pos + 1). Only for whoever the queue
 * bills (its starter) or a library admin on a free queue (mayGrow) - anyone else gets code not_starter. The queue's limits
 * (titles, hours) apply. 1.99ajk plexchat review: on a PAID queue what it adds to the bill (addCost) must be the figure the starter
 * said yes to - `opts.estimate` (400 when missing, 409 with the new figure when it changed), like a queue's start.
 * -> {ok, added, items, next (the first added title's name), cost}
 */
async function addNext(user, room, keys, opts = {}) {
  await L().init();
  if (!user || !user.userId) throw refuse(401, "Sign in first.", { code: "signin" });
  await I().mustAccess(user);
  const R = await I().roomOf(room);
  if (!R) throw refuse(404, "No such pad.", { code: "pad" });
  return withLock(R.id, async () => {
    const q = await activeFor(R.id);
    if (!q) throw refuse(404, "There's no queue playing on this pad.", { code: "nothing_on" });
    if (!(await mayGrow(user, q))) {
      throw refuse(403, `${q.username || "Someone"}'s queue is playing - when it ends, ask again (or they can add it).`, { code: "not_starter", by: q.username || null });
    }
    const S = conf.get();
    // opts.scope (season / season_rest / series_from) with ONE episode key: that run of the show, as a queue's start builds it
    const one = Array.isArray(keys) && keys.length === 1 && opts && ["season", "season_rest", "series_from"].includes(opts.scope);
    const add = await build(one ? { key: String(keys[0]), scope: opts.scope } : { keys }, { ...S, library_queue_max_items: 200, library_queue_max_hours: 24 });
    const room_ = S.library_queue_max_items - q.items.length;
    if (room_ <= 0) throw refuse(409, `A queue holds at most ${S.library_queue_max_items} titles.`, { code: "queue_full" });
    const s = await I().session(R.id);
    const curLeft = s ? Math.max(0, (s.duration || 0) - (s.position || 0)) : 0;
    let left = curLeft + totalSec(q.items.slice(q.pos + 1));
    const put = [];
    for (const it of add.items.slice(0, room_)) {
      if (left + it.duration > S.library_queue_max_hours * 3600) break;
      put.push(it); left += it.duration;
    }
    if (!put.length) throw refuse(409, `A queue holds at most ${S.library_queue_max_hours} hours.`, { code: "queue_full" });
    const cost = addCost(q, s, totalSec(put));
    if (cost > 0) {
      const est = opts && opts.estimate;
      if (est == null || est === "") throw refuse(400, `That adds about ${I().fmtPat(cost)} PAT to the queue as it plays - confirm it to add it.`, { estimate: cost, code: "estimate" });
      if (Math.floor(Number(est)) !== cost) throw refuse(409, `It adds about ${I().fmtPat(cost)} PAT now - confirm it again.`, { estimate: cost, code: "estimate" });
    }
    q.items.splice(q.pos + 1, 0, ...put);
    const slot = await stage.getSlot(q.slot_id);
    if (slot) await stage.libraryExtend(q.slot_id, Math.ceil(((slot.live_ms || 0) / 1000 + left) / 60) + I().SLACK_MIN).catch(() => {});
    await saveItems(q);
    await I().logControl(user, R.id, "queue_next", `${put.length} title(s): ${fmtTitle(put[0])}`, { queue_id: q.id });
    return { ok: true, added: put.length, items: q.items.length, next: fmtTitle(put[0]), queue_id: q.id, cost };
  });
}

async function step(user, room, dir) {
  const { R } = await needQueue(user, room);
  return withLock(R.id, async () => {
    const q = await activeFor(R.id);
    if (!q || !(await canControl(user, q))) throw refuse(404, "There's no queue playing on this pad.", { code: "nothing_on" });
    const to = q.pos + dir;
    // 1.99ajk plexchat: ⏭ on the last title, when it's an episode, plays the show's next one (appended first) - only on a FREE
    // queue (1.99ajk review: a paid one would grow its starter's bill past the estimate they confirmed) and only for its starter or
    // a library admin (mayGrow)
    if (to >= q.items.length && dir > 0 && !(Number(q.per_hour) > 0) && q.items.length < (conf.get().library_queue_max_items || 60)
        && (await mayGrow(user, q))) {
      const nxt = await nextEpisodeOf(q.items[q.pos]).catch(() => null);
      if (nxt) {
        q.items.push(nxt);
        await saveItems(q);
        const s0 = await I().session(R.id);
        const left = (s0 ? Math.max(0, (s0.duration || 0) - (s0.position || 0)) : 0) + nxt.duration;
        const slot = await stage.getSlot(q.slot_id);
        if (slot) await stage.libraryExtend(q.slot_id, Math.ceil(((slot.live_ms || 0) / 1000 + left) / 60) + I().SLACK_MIN).catch(() => {});
      }
    }
    if (to >= q.items.length) throw refuse(409, "That's the last title - ⏹ Stop ends the queue.", { code: "last_title" });
    if (to < 0) throw refuse(409, "That's the first title.", { code: "first_title" });
    const s = await I().session(R.id);
    let r;
    if (s && Number(s.queue_id) === Number(q.id)) {
      const pos = await stopEncoder(R.id);
      r = await advance(q, s, dir > 0 ? "skipped" : "back", { pos: pos != null ? pos : s.position, by: user.username, to });
    } else r = await goTo(q, to);
    if (r && r.ok && !r.break) I().noteRestart(R.id, 0, r.play_id);   // 1.99acx: started right after a stop (upnext2: not after a station break)
    await I().logControl(user, R.id, dir > 0 ? "next" : "prev", q.items[to] ? fmtTitle(q.items[to]) : null, { queue_id: q.id });
    return { ok: true, ...r, pos: q.pos };
  });
}
const next = (user, room) => step(user, room, 1);
const prev = (user, room) => step(user, room, -1);

/** plexreplace: a ▶ "Play this instead" took this queue's slot over (inside the pad's lock - medialib.retire): the title on now stops, its
 *  play closes ("replaced by <who>"), the queue ends - its slot already ended 'library_replaced' with the swap. */
// upnext3 (1.99ali): rep.end = a system hand-over took the slot over after this queue ended by itself / was stopped (its own reason, notice and
// who - endQueue); rep.hold = a booking that came due takes the stage at this queue's title change: the queue pauses (holdQueue), it carries
// on after the booking (resumeQueue)
async function retireForReplace(q0, user, rep = {}, toSlot = null) {
  const q = await load(q0.id);
  if (!q || !["active", "starting"].includes(q.state)) return false;
  if (rep && rep.hold) return holdQueue(q, rep.hold, toSlot);
  if (rep && rep.end) { await endQueue(q, rep.end.reason, { ...rep.end, slotDone: true }); return true; }
  await brkStop(q, user);
  await endQueue(q, `replaced by ${user.username}`, { by: user.username, slotDone: true, how: "replaced" });
  return true;                             // (the control log's line is the play's own "replace": <what was on> → <the new title>)
}

async function stop(user, q0, reason = "stopped") {
  if (!(await canControl(user, q0))) throw refuse(403, I().CONTROL_DENIED);
  return withLock(q0.room_id, async () => {
    const q = await load(q0.id);
    // (upnext3, item 7: "Start them instead." - whoever is lined up after it takes the stage over, its station break first)
    if (q && q.state === "active") { await brkStop(q, user); await endOrHand(q, `${reason} by ${user.username}`, { by: user.username }); }
    await I().logControl(user, q0.room_id, "stop", "the queue", { queue_id: q0.id });
    return { ok: true };
  });
}
/** upnext2 review (safety F3, 1.99alc): its starter ended the queue in a station break (⏹ / their own replace) - it counts on their daily cap even
 *  when no title ever started (medialib.paidToday / freeToday) */
async function brkStop(q, user) {
  if (!q || !q.brk || !user || user.userId !== q.user_id) return;
  try { await runQuery("UPDATE media_queues SET brk_stop = 1 WHERE id = ?", [q.id]); } catch (e) { /* the cap is best effort */ }
}

/** What's left: remove / move / add (titles already played or on now don't change). b = {op, index, to, keys} */
async function edit(user, room, b = {}) {
  const { R } = await needQueue(user, room);
  return withLock(R.id, async () => {
    const q = await activeFor(R.id);
    if (!q || !(await canControl(user, q))) throw refuse(404, "There's no queue playing on this pad.");
    const S = conf.get();
    const logIt = () => I().logControl(user, R.id, "queue_" + String(b.op || "").slice(0, 8),
      b.op === "add" ? `${(b.keys || []).length} title(s)` : `#${Number(b.index) + 1}` + (b.op === "move" ? ` → #${Number(b.to) + 1}` : ""), { queue_id: q.id });
    const idx = Math.floor(Number(b.index)), to = Math.floor(Number(b.to));
    const later = (i) => Number.isInteger(i) && i > q.pos && i < q.items.length;
    if (b.op === "remove") {
      if (!later(idx)) throw refuse(400, "Only what's still to come can be removed.");
      q.items.splice(idx, 1);
    } else if (b.op === "move") {
      if (!later(idx) || !later(to)) throw refuse(400, "Only what's still to come can be moved.");
      const [it] = q.items.splice(idx, 1);
      q.items.splice(to, 0, it);
    } else if (b.op === "add") {
      // upnext2 (review of the investigation's gap): adding titles is growing someone's bill - only whoever the queue bills (its starter) or a
      // library admin on a free queue (mayGrow, as Pepe's "queue it next"), and on a PAID queue what it adds must be the figure they said yes to
      if (!(await mayGrow(user, q))) throw refuse(403, `${q.username || "Someone"}'s queue is playing - only they can add to it.`, { code: "not_starter", by: q.username || null });
      const add = await build({ keys: b.keys }, { ...S, library_queue_max_items: 200, library_queue_max_hours: 24 });
      const room_ = S.library_queue_max_items - q.items.length;
      if (room_ <= 0) throw refuse(409, `A queue holds at most ${S.library_queue_max_items} titles.`, { code: "queue_full" });
      const s = await I().session(R.id);
      const curLeft = s ? Math.max(0, (s.duration || 0) - (s.position || 0)) : 0;
      let left = curLeft + totalSec(q.items.slice(q.pos + 1));
      const put = [];
      for (const it of add.items.slice(0, room_)) {
        if (left + it.duration > S.library_queue_max_hours * 3600) break;
        put.push(it); left += it.duration;
      }
      const added = put.length;
      if (!added) throw refuse(409, `A queue holds at most ${S.library_queue_max_hours} hours.`, { code: "queue_full" });
      const cost = addCost(q, s, totalSec(put));
      if (cost > 0) {
        if (b.estimate == null || b.estimate === "") throw refuse(400, `That adds about ${I().fmtPat(cost)} PAT to the queue as it plays - confirm it to add it.`, { estimate: cost, code: "estimate" });
        if (Math.floor(Number(b.estimate)) !== cost) throw refuse(409, `It adds about ${I().fmtPat(cost)} PAT now - confirm it again.`, { estimate: cost, code: "estimate" });
      }
      q.items.push(...put);
      const slot = await stage.getSlot(q.slot_id);
      if (slot) await stage.libraryExtend(q.slot_id, Math.ceil(((slot.live_ms || 0) / 1000 + left) / 60) + I().SLACK_MIN).catch(() => {});
      await saveItems(q);
      await logIt();
      return { ok: true, added, items: q.items.length };
    } else throw refuse(400, "Bad change.");
    await saveItems(q);
    await logIt();
    return { ok: true, items: q.items.length };
  });
}

// ── upnext2 (E): "+ Add to the queue" while a SINGLE 📼 title is on (owner 2026-11-05: "unless there is an existing queue, Plex doesn't show
// the 'add to the queue' button. Just a play this instead button.") ──
// Titles added behind a single play start a queue of the ADDER's own that waits behind it (media_queues state 'after', behind = that play's
// slot): their titles, their estimate confirmed now, charged as it plays like any queue they start (never cheaper than ▶ Play), one play
// towards their daily cap when it starts. It starts when the title on now ends by itself (medialib.watchOne -> startAfter): it takes the pad's
// stage over like ▶ Play this instead (the feature and the "Coming up next" card carry; the station break first). Who: whoever may ▶ Play on
// the pad - medialib.preflight without its busy checks (access, the pad, not banned there, no stage slot of their own, the daily cap); the
// library admins / the pad's owner with access as anyone. A second "+ Add" by its owner (or a library admin on a free one - mayGrow) grows it;
// anyone else: not_starter. ⏹ / ▶ Play this instead / a Cut of the title on now = what it waited for is gone: it ends, with a notice.
// Not behind a RUNNING queue: its starter's "+ Add to the queue that's playing" grows it (edit op add); anyone else's titles inside someone's
// queue would need per-title billing - an owner question.
// upnext3 (1.99ali, owner 2026-11-07: "Let someone add their own "queue" after someone else's queue."): the same behind someone else's RUNNING
// queue, and several people in turn - a LINE, first come first served (lineFor): each person's own queue (their titles, their estimate,
// billed to them as it plays - never a title inside anyone else's queue), at most AFTER_MAX people; a second "+" by the same person grows
// their own row (a library admin lines up their own too - never grows someone else's). Whenever the stage frees up - the title / queue on
// ends by itself, ⏹, a Cut of that slot, a failed / lost start - the next one takes it over (handOver); a cut of the whole pad / site, a cut +
// ban, a ban, Play from Plex off or no free encoder anywhere clears the line instead (cancelLine, a notice to each).
/** The oldest person lined up on the pad (upnext2's "the" row - the head of the people in the line) */
async function afterFor(roomId) {
  const r = (await getQuery("SELECT id FROM media_queues WHERE room_id = ? AND state = 'after' AND resume IS NULL ORDER BY id LIMIT 1", [String(roomId || "")]))[0];
  return r ? load(r.id) : null;
}
async function lineRows(roomId) {
  const out = [];
  for (const r of await getQuery("SELECT id FROM media_queues WHERE room_id = ? AND state = 'after' ORDER BY CASE WHEN resume IS NULL THEN 1 ELSE 0 END, id", [String(roomId || "")])) {
    const q = await load(r.id);
    if (q && q.state === "after") out.push(q);
  }
  return out;
}
/** Who's next on a pad's 📼 stage, in order: bookings whose time came (by their time), a queue paused for one (it carries on), then the people
 *  lined up. -> [{kind: booking | resume | after, bk | row, user_id, username, first (slim title), count, at (a booking's time)}] */
async function lineFor(roomId) {
  const id = String(roomId || "");
  await bookingsInit();
  const out = [];
  const bks = await getQuery(`SELECT b.* FROM media_bookings b JOIN stage_slots sl ON sl.id = b.slot_id
                              WHERE b.room_id = ? AND (b.state = 'waiting' OR (b.state = 'booked' AND b.start_at <= ?)) AND sl.status = 'scheduled' AND sl.settled = 0
                              ORDER BY b.start_at, b.created`, [id, NOW()]).catch(() => []);
  for (const b of bks) out.push({ kind: "booking", bk: b, user_id: b.user_id, username: b.username, first: parse(b.first, null), count: Number(b.items) || 1, at: Number(b.start_at) });
  for (const q of await lineRows(id)) {
    const held = q.resume != null;
    const from = held ? Math.max(0, Number(q.brk && q.brk.pos != null ? q.brk.pos : q.pos) || 0) : 0;
    out.push({ kind: held ? "resume" : "after", row: q, user_id: q.user_id, username: q.username, first: q.items[from] || null, count: Math.max(0, q.items.length - from) });
  }
  return out;
}
/** A due booking waits on pad roomId (it goes first: a fresh ▶ / a replace is refused booking_next) */
async function bookingDue(roomId) {
  return (await lineFor(roomId).catch(() => [])).some((h) => h.kind === "booking");
}
const transientErr = (e) => !!(e && (e.busy || e.status === 429 || e.status === 502 || e.status === 503 ||
  ["replace_gone", "busy_library", "site_full"].includes(e.code) || (e.extra && ["encoder_down", "encoder_busy", "busy_library", "busy_queue"].includes(e.extra.code))));
const cleared = (sl) => !!(sl && (sl.end_reason === "banned" || sl.end_scope === "pad" || sl.end_scope === "ban"));
// upnext3 review (ux 3, 1.99ali): what a stage cleared on purpose takes with it - the picks lined up behind what was on (kind 'after') always; a queue
// paused for a booking only when the WHOLE pad was cut (a cut + ban / a ban is aimed at one person: it carries on); a booking never (it has its own
// time on the schedule, as every booking after it - it starts on the free stage; the banned person's own entries are refused at their start)
const clearKinds = (scope) => (scope === "pad" ? ["after", "resume"] : ["after"]);
const scopeOf = (sl) => (sl && sl.end_scope === "pad" ? "pad" : "ban");
// (review ux 13: a notice quoting a refusal says points - "Starting it takes 2,000 PAT ..." is "2,000 points" there)
const points = (t) => String(t == null ? "" : t).replace(/\bPAT\b/g, "points");
/** (inside the lock) one row of the line ends unstarted - its owner gets a notice. -> ended it? */
async function cancelRow(w, why0, notice = null) {
  const held = w.resume != null, why = points(why0);
  const c = await runQuery("UPDATE media_queues SET state = 'ended', ended_at = ?, end_reason = ?, notice = ?, updated = ? WHERE id = ? AND state = 'after'",
                           [NOW(), ((held ? "didn't carry on: " : "didn't start: ") + String(why || "")).slice(0, 120), notice || (held ? "held_cancelled" : "after_cancelled"), NOW(), w.id]);
  if (!(c && c.changes)) return false;
  const pad = await padTitle(w.room_id);
  // (review money 5: a paused queue that paid for a started hour and played only part of it - said plainly, not "nothing more was charged" alone)
  const unusedMin = held && Number(w.per_hour) > 0 ? Math.floor(Math.max(0, Number(w.paid_hours) * 3600 - Number(w.played_sec || 0)) / 60) : 0;
  await require("./inbox").addSafe(w.user_id, held
    ? { kind: "media", title: `📼 Your queue on ${pad} didn't carry on`, link: "/stage", ref: "mlibheld-end:" + w.id,   // (review: its own ref - "mlibheld:" is the pause's)
        body: `${String(why || "It couldn't carry on").slice(0, 160)} - nothing more was charged` +
              (unusedMin > 0 ? `; the ${unusedMin} minute${unusedMin === 1 ? "" : "s"} left of the hour it had paid for ${unusedMin === 1 ? "isn't" : "aren't"} refunded.` : ".") }
    : { kind: "media", title: `📼 Your titles up next on ${pad} didn't start`,
        body: `${String(why || "What they waited for ended").slice(0, 160)} - nothing was charged. Add them again any time.`, link: "/stage", ref: "mlibafter:" + w.id });
  console.log(`[mediaqueue] ${held ? "paused queue" : "after-queue"} #${w.id} on ${w.room_id} ended: ${why}`);
  return true;
}
/** (inside the lock) Play from Plex off / no encoder anywhere / the stage cleared on purpose: the line's rows of `kinds` end unstarted (the picks
 *  lined up - 'after' - and queues paused for a booking - 'resume'), a notice to each. A booking is never cancelled here (review ux 3: its own
 *  watcher starts it, or fails it for a reason of its own - Play from Plex off included). Never throws. -> how many */
async function cancelLine(roomId, why, { kinds = ["after", "resume"] } = {}) {
  let n = 0;
  try {
    for (const h of await lineFor(roomId)) {
      if (h.kind === "booking" || !kinds.includes(h.kind)) continue;
      if (await cancelRow(h.row, why)) n++;
    }
  } catch (e) { console.error("[mediaqueue] line:", conf.errLine(e)); }
  if (n) { try { stage.stageBump(roomId); } catch (e) { /* the 2 s cache */ } }
  return n;
}
/** (inside the lock) a line's head that won't start for a reason of its own: it ends with that reason, the next one tries */
async function dropHead(h, e) {
  const why = (e && e.message) || "it couldn't start";
  if (h.kind === "booking") return bookingFailed(h.bk, e && e.outOfPat && !/takes/.test(why) ? "You're out of points - top up to keep watching." : why);
  return cancelRow(h.row, why);
}
/** (inside the lock) a busy / unreachable media-control held a head up: it keeps its place (the watcher tries again - RETRY_MS for a row, a
 *  booking's start window from now) */
async function noteRetry(h) {
  if (h.kind === "booking") await runQuery("UPDATE media_bookings SET free_at = COALESCE(free_at, ?) WHERE slot_id = ?", [NOW(), h.bk.slot_id]).catch(() => {});
  else await runQuery("UPDATE media_queues SET retry_since = COALESCE(retry_since, ?) WHERE id = ?", [NOW(), h.row.id]).catch(() => {});
}
/** everyone still lined up waits behind slot `slotId` now */
// (review money 1: and their retry clock starts over - a busy media-control that once held one up never cancels it while it waits behind a title)
async function lineBehind(roomId, slotId) {
  if (!slotId) return;
  await runQuery("UPDATE media_queues SET behind = ?, retry_since = NULL, updated = ? WHERE room_id = ? AND state = 'after'", [String(slotId), NOW(), String(roomId)]).catch(() => {});
}
/** a booking whose time came waits on pad roomId (it goes first) / anyone is lined up (review money 1: a fresh ▶ on a free stage waits for them) */
async function lineWaits(roomId) {
  return (await lineFor(roomId).catch(() => [])).some((h) => h.kind !== "booking");
}
/** (inside the lock) start the line's head `h` - a booking (its slot), a paused queue (it carries on), a person's row (their own queue) - taking
 *  the stage over from `rep` (an open slot: the swap) or on a free stage (rep null). Every one of its owner's rules applies again now
 *  (access, the pad, the daily cap, the points, the estimate they said yes to). -> {queue_id, slot_id}; throws the refusal */
async function startHead(R, h, rep, { reason = "library_done", actor = null } = {}) {
  const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [h.user_id]))[0];
  if (!u) throw refuse(410, "The account is gone.");
  const A = await L().access(u);
  if (!A.ok) throw refuse(403, A.message || "Playing from Plex isn't open to you right now.");
  const sys = { rep, reason, actor, system: true };
  if (h.kind === "booking") {
    // (review money 3: its confirmed estimate goes with it; money 6: launch marks it 'started' with its queue)
    const r = await launch(u, A, R, { ...parse(h.bk.req, {}), room: R.id }, { slot_id: h.bk.slot_id, estimate: h.bk.estimate }, sys);
    if (h.bk.state === "waiting") await startNotice(R, u.userId, "booking", r, h.bk.slot_id).catch(() => {});   // (review ux 5: one that waited is told)
    return { queue_id: r.queue_id, slot_id: r.slot.id };
  }
  if (h.kind === "resume") {
    const r = await resumeQueue(u, A, R, h.row, sys);
    await startNotice(R, u.userId, "resume", r, h.row.id).catch(() => {});
    return r;
  }
  const w = h.row, req = (w.prefs && w.prefs.req) || {};
  const r = await launch(u, A, R, { room: R.id, keys: w.items.map((x) => x.key), quality: req.quality, audio: req.audio, sub: req.sub, offset: req.offset,
                                    estimate: w.prefs && w.prefs.est ? w.prefs.est : undefined }, null, { ...sys, after: true, afterId: w.id });
  console.log(`[mediaqueue] after-queue #${w.id} on ${R.id} started as queue #${r.queue_id}`);
  await startNotice(R, u.userId, "after", r, w.id).catch(() => {});
  return { queue_id: r.queue_id, slot_id: r.slot.id };
}
/** upnext3 review (ux 5, 1.99ali): someone lined up may start hours after they pressed - their inbox says it's on now, about how many points it
 *  takes as it plays, and how to stop it. kind = after (their own queue) | resume (a paused queue carrying on) | booking (one that waited). */
async function startNotice(R, userId, kind, r, ref) {
  const q = r && r.queue_id ? await load(r.queue_id) : null;
  if (!q) return;
  const pad = R.title || R.id, from = Math.max(0, Number(q.pos) || 0), first = q.items[from] ? fmtTitle(q.items[from]) : (r.title || null);
  const est = kind === "resume"
    ? (Number(q.per_hour) > 0 ? Math.max(0, Math.ceil((q.played_sec + totalSec(q.items.slice(from))) / 3600) - q.paid_hours) * q.per_hour : 0)
    : Math.max(0, Number(r.estimate) || 0);
  const cost = est > 0 ? ` - about ${I().fmtPat(est)} points ${kind === "resume" ? "more" : "in all"}, charged as it plays (only what actually plays)` : "";
  const title = kind === "resume" ? `📼 Your queue on ${pad} carries on` : kind === "booking" ? `📼 Your booked Plex stream on ${pad} is starting` : `📼 Your queue on ${pad} is starting`;
  await require("./inbox").addSafe(userId, { kind: "media", title, link: "/p/" + encodeURIComponent(R.slug || R.id),
    body: `${first ? `“${first}” is ${q.brk ? "up next, after the pad's station break" : "on now"}` : q.brk ? "It's up next, after the pad's station break" : "It's on now"}${cost}. ⏹ in the pad's 📼 player stops it.`,
    ref: `mlibstart:${kind}:${ref}` + (kind === "resume" ? ":" + NOW() : "") });
}
/**
 * (inside the pad's lock - never withLock) The stage on pad R frees up: `from` comes off ({slot_id, s, q, starter, by, title, open, why,
 * end, hold}); whoever is next in its line takes it over. from.open = its slot is still open: a SYSTEM SWAP (mainstage.libraryOpen /
 * libraryActivate {replace}: the feature and the "Coming up next" card carry over, the station break first; medialib.retire closes what was on
 * with from.why / from.end / from.hold); otherwise a fresh start. A head that can't start for a reason of its own is cancelled with it and the
 * next one tries; a busy / unreachable media-control stops the walk (the rest keep their places - lineLook tries again).
 * -> {started, retired (what was on is closed: the caller must not end it again), queue_id}
 */
async function handOver(R, from, { reason = "library_done", actor = null } = {}) {
  let open = !!(from && from.open && from.slot_id), retired = false;
  const seq0 = stage.clearOf(R.id).seq;                                 // (review money 4: a cut of the whole pad / a cut + ban landing half-way)
  for (let k = 0; k < AFTER_MAX + 3; k++) {
    const h = (await lineFor(R.id))[0];
    if (!h) break;
    const rep = open ? { ...from, why: from.why || "finished" } : null;
    try {
      const r = await startHead(R, h, rep, { reason, actor });
      await lineBehind(R.id, r.slot_id);
      try { stage.stageBump(R.id); } catch (e) { /* the 2 s cache */ }
      return { started: true, retired: open || retired, queue_id: r.queue_id };
    } catch (e) {
      if (open) {
        const sl = await stage.getSlot(from.slot_id).catch(() => null);
        if (!sl || sl.settled || !["waiting", "active"].includes(sl.status)) { open = false; retired = true; }   // (the swap had happened)
      }
      console.warn(`[mediaqueue] ${R.id}: the next ${h.kind} (${h.username || h.user_id}) didn't take the stage: ${conf.errLine(e)}`);
      // (review money 4: the stage was cleared on purpose meanwhile - what it clears goes, with that reason, and nobody else starts in this walk;
      // a booking / a paused queue it keeps: their own watcher, on the next look)
      const c = stage.clearOf(R.id);
      if (c.seq !== seq0) {
        await cancelLine(R.id, c.title ? `“${String(c.title).replace(/^📼\s*/, "")}” was cut and the stage cleared` : "the pad's stage was cut and cleared", { kinds: clearKinds(c.scope) });
        break;
      }
      if (transientErr(e)) { await noteRetry(h); break; }
      await dropHead(h, e);
    }
  }
  return { started: false, retired };
}
/** (inside the lock) the stage on pad roomId was emptied by an end (slot = the slot that ended, or its id): what's lined up starts - unless the
 *  stage was cleared on purpose (a cut of the whole pad / site, a cut + ban, a ban) or Play from Plex is off. -> handOver's answer */
async function afterEnded(roomId, slot) {
  try {
    const sl = slot && typeof slot === "object" ? slot : slot ? await stage.getSlot(slot).catch(() => null) : null;
    if (!conf.on.library()) { await cancelLine(roomId, "Play from Plex was switched off"); return { started: false }; }
    // (review ux 3: the picks behind it go - a paused queue too when the whole pad was cut; a booking, or a paused queue after a cut + ban, starts)
    if (cleared(sl)) await cancelLine(roomId, `“${String(sl.title || "what was on").replace(/^📼\s*/, "")}” was cut and the stage cleared`, { kinds: clearKinds(scopeOf(sl)) });
    if (!(await lineFor(roomId)).length) return { started: false };
    const R = await I().roomOf(roomId);
    if (!R) return { started: false };
    return await handOver(R, { slot_id: sl ? sl.id : null, open: false }, { reason: "library_done" });
  } catch (e) { console.error("[mediaqueue] after:", conf.errLine(e)); return { started: false }; }
}
/** (inside the lock) queue q is over (reason / opts as endQueue): with someone lined up after it, they take its slot over (the system swap);
 *  else - or when none could start - it ends as ever */
async function endOrHand(q, reason, opts = {}) {
  const stageReason = opts.stageReason || (reason === "finished" ? "library_done" : "library_stopped");
  if (conf.on.library() && (await lineFor(q.room_id).catch(() => [])).length) {
    const R = await I().roomOf(q.room_id).catch(() => null);
    const sl = await stage.getSlot(q.slot_id).catch(() => null);
    const open = !!(sl && !sl.settled && ["waiting", "active"].includes(sl.status));
    if (R && open) {
      const cur = q.items[q.pos];
      const from = { slot_id: q.slot_id, s: null, q, starter: q.user_id, by: q.username, title: cur ? fmtTitle(cur) : null, left: 0, open: true, why: reason,
                     end: { reason, notice: opts.notice || null, by: opts.by || "system", stageReason, how: opts.how || "stopped" } };
      const h = await handOver(R, from, { reason: stageReason, actor: opts.by && opts.by !== "system" ? opts.by : null });
      if (h.retired) return h;
    }
    if (R && !open) { await endQueue(q, reason, opts); return afterEnded(q.room_id, q.slot_id); }
  }
  await endQueue(q, reason, opts);
  return { started: false };
}
/** (inside the lock - retire) a booking takes the stage at this queue's title change: the queue PAUSES where it is (state 'after', resume = when,
 *  brk = {pos, offset, tracks} - title `pos` comes next), keeps its paid hours / what it played / its one daily play, and carries on right
 *  after the booking (resumeQueue). Its starter gets a notice. */
async function holdQueue(q, hold, toSlot) {
  const s = await I().session(q.room_id);
  if (s && Number(s.queue_id) === Number(q.id)) { const pos = await stopEncoder(q.room_id); await finishTitle(q, s, "stopped", { pos: pos != null ? pos : s.position }); }
  const h = { pos: Math.max(0, Number(hold.pos) || 0), offset: Math.max(0, Number(hold.offset) || 0), tracks: hold.tracks || null };
  await runQuery("UPDATE media_queues SET state = 'after', resume = ?, pos = ?, brk = ?, slot_id = NULL, behind = ?, retry_since = NULL, notice = 'held', updated = ? WHERE id = ? AND state IN ('active','starting')",
                 [NOW(), h.pos, JSON.stringify(h), toSlot ? String(toSlot) : null, NOW(), q.id]);
  q.state = "after";
  const pad = await padTitle(q.room_id), nxt = q.items[h.pos];
  await require("./inbox").addSafe(q.user_id, { kind: "media", title: `📼 Your queue on ${pad} pauses for a booked stream`,
    body: `A stream booked for this time plays now; your queue carries on right after it${nxt ? `, from “${fmtTitle(nxt)}”` : ""}. Nothing more is charged until it does.`,
    link: "/stage", ref: "mlibheld:" + q.id + ":" + NOW() });          // (review: a queue may pause twice - each pause is told)
  console.log(`[mediaqueue] queue #${q.id} on ${q.room_id} paused at ${h.pos + 1}/${q.items.length} for a booking (behind slot ${toSlot})`);
  return true;
}
/** (inside the lock) a paused queue carries on (the line's head after the booking it waited for): a fresh slot of its starter's - the swap
 *  from `rep` when its slot is open - the SAME queue row (its paid hours, what it played, one daily play), its station break, then title
 *  `pos` from where it was. -> {queue_id, slot_id}; throws the refusal (its own: cancelled with it) */
async function resumeQueue(u, A, R, q, { rep = null, reason = "library_done", actor = null } = {}) {
  // (the daily cap isn't asked again: it is the same play)
  await I().preflight(u, A, R, { replacing: rep, system: true, resume: true });
  const hold = q.brk || { pos: q.pos, offset: 0, tracks: null };
  const pos = Math.max(0, Number(hold.pos) || 0), off = Math.max(0, Number(hold.offset) || 0);
  const cur = q.items[pos];
  if (!cur) throw refuse(400, "Nothing is left in it.");
  if (q.per_hour > 0) {
    const need = Math.max(0, hoursNeeded(q.played_sec, cur.duration, off) - q.paid_hours) * q.per_hour, have = await balanceOf(u.userId);
    if (need > 0 && have < need) throw Object.assign(refuse(402, `Carrying on takes ${I().fmtPat(need)} points and you have ${I().fmtPat(have)}.`, { code: "pat", need }), { outOfPat: true, need });
  }
  await I().needEncoder(rep ? R.id : null);
  const it = await I().fetchItem(cur.key).catch(() => null);
  const rest = totalSec(q.items.slice(pos), off);
  const opened = await stage.libraryOpen(u, { room: R.id, title: "📼 " + fmtTitle(it || cur), minutes: Math.min(24 * 60, Math.ceil(rest / 60) + I().SLACK_MIN),
    ...(rep ? { replace: rep.slot_id, reason, upnext: L().upNextInfo(it || cur), ...(actor ? { actor } : {}) } : {}) });
  if (rep) await I().retire(u, R, rep, opened.slot.id);
  L()._keys.set(R.id, opened.key);
  const c = await runQuery("UPDATE media_queues SET state = 'active', slot_id = ?, behind = NULL, resume = NULL, brk = NULL, retry_since = NULL, notice = NULL, updated = ? WHERE id = ? AND state = 'after'",
                           [opened.slot.id, NOW(), q.id]);
  if (!(c && c.changes)) { await stage.end(opened.slot.id, "library_failed", "system").catch(() => {}); throw refuse(409, "It was taken out meanwhile."); }
  const q2 = await load(q.id);
  console.log(`[mediaqueue] queue #${q.id} on ${R.id} carries on at ${pos + 1}/${q.items.length} on slot ${opened.slot.id}`);
  await goTo(q2, pos, { offset: off, tracks: hold.tracks || null });
  return { queue_id: q.id, slot_id: opened.slot.id };
}
/** (inside the lock - goTo) a booking whose time came waits for the title on - queue q is at its title change (title i next): the booking takes
 *  the stage now, q pauses and carries on after it. A booked queue is never cut short by another booking. -> goTo's answer | null (go on) */
async function yieldToBooking(q, i, { offset = 0, tracks = null } = {}) {
  const h = (await lineFor(q.room_id).catch(() => []))[0];
  if (!h || h.kind !== "booking") return null;
  if ((await getQuery("SELECT 1 FROM media_bookings WHERE queue_id = ? LIMIT 1", [q.id]).catch(() => []))[0]) return null;
  const R = await I().roomOf(q.room_id).catch(() => null);
  if (!R) return null;
  const sl = await stage.getSlot(q.slot_id).catch(() => null);
  if (!sl || sl.settled || !["waiting", "active"].includes(sl.status)) return null;
  const prev = q.items[i - 1] || q.items[q.pos];
  const rep = { slot_id: q.slot_id, s: null, q, starter: q.user_id, by: q.username, title: prev ? fmtTitle(prev) : null, left: 0, open: true, why: "paused for a booking",
                hold: { pos: i, offset, tracks } };
  try {
    const r = await startHead(R, h, rep, { reason: "library_done" });
    await lineBehind(R.id, r.slot_id);
    try { stage.stageBump(R.id); } catch (e) { /* the 2 s cache */ }
    return { ok: true, break: true, held: true, queue_id: r.queue_id, price: 0 };
  } catch (e) {
    console.warn(`[mediaqueue] ${R.id}: the booking due didn't take the stage at queue #${q.id}'s title change: ${conf.errLine(e)}`);
    // (review money 2: held up for now - the queue keeps the stage, so no start window begins: the booking tries again at the next title change, or
    // when the stage really frees up)
    if (!transientErr(e)) await dropHead(h, e);
    const q2 = await load(q.id);
    if (q2 && q2.state === "active") return null;                     // (refused before the swap: the queue goes on as ever)
    // the swap happened and the booking then failed: the paused queue is next - it carries on on a fresh slot
    const x = await handOver(R, { slot_id: q.slot_id, open: false }, { reason: "library_failed" });
    return { ok: true, ended: !x.started, held: true };
  }
}
/** (inside the lock - watchIdle) what a restart or a busy media-control left in pad roomId's line, and the waits' caps: a paused queue waits at
 *  most the pad's 📼 limit, a row a busy media-control held up RETRY_MS; behind a slot that went without a hand-over: behind what's on now
 *  (or cancelled - the stage was cleared); nothing on: the head starts (bookings: watchBookings) */
async function lineLook(roomId) {
  const lim = Number((await stage.limitsFor(roomId).catch(() => ({ library_max: 360 }))).library_max) || 360;
  for (const h of await lineFor(roomId)) {
    if (h.kind === "booking") continue;
    if (h.kind === "resume" && NOW() - Number(h.row.resume) > lim * 60000) await cancelRow(h.row, "what it was paused for ran past this pad's 📼 limit");
    else if (h.row.retry_since && NOW() - Number(h.row.retry_since) > RETRY_MS) await cancelRow(h.row, "no library stream came free in time");
  }
  const line = await lineFor(roomId);
  const rows = line.filter((h) => h.kind !== "booking");
  if (!rows.length) return;
  if ((await getQuery("SELECT 1 FROM media_queues WHERE room_id = ? AND state = 'starting' LIMIT 1", [roomId]))[0]) return;   // (one starting: next look)
  const R = await I().roomOf(roomId);
  if (!R) return;
  const cur = await I().onNow(R);
  if (cur && cur.busy) return;
  if (cur) {
    for (const h of rows) {
      if (String(h.row.behind || "") === String(cur.slot_id)) continue;
      const bs = h.row.behind ? await stage.getSlot(h.row.behind).catch(() => null) : null;
      if (cleared(bs) && clearKinds(scopeOf(bs)).includes(h.kind)) await cancelRow(h.row, "the stage was cleared");
      // (review money 1: waiting behind what's on now - its retry clock starts over)
      else await runQuery("UPDATE media_queues SET behind = ?, retry_since = NULL, updated = ? WHERE id = ? AND state = 'after'", [String(cur.slot_id), NOW(), h.row.id]);
    }
    return;
  }
  if (line[0].kind === "booking") return;                             // (its own watcher starts it)
  const bs = rows[0].row.behind ? await stage.getSlot(rows[0].row.behind).catch(() => null) : null;
  if (bs && !bs.settled && ["waiting", "active"].includes(bs.status)) return;   // (a slot between two plays: the next look)
  await afterEnded(roomId, bs || null);
}
async function after(user, b = {}) {
  await L().init();
  if (!user || !user.userId) throw refuse(401, "Sign in first.", { code: "signin" });
  const A = await I().mustAccess(user);
  const S = conf.get();
  if (S.library_queue === false) throw refuse(403, "Queues are switched off right now.", { code: "queue_off" });
  const R = await I().roomOf(b.room);
  if (!R || !(await stage.seesPad(user, R.id))) throw refuse(404, "No such pad.", { code: "pad" });
  return withLock(R.id, async () => {
    const cur = await I().onNow(R);
    if (cur && cur.busy) throw refuse(409, "A queue is starting on this pad - try again in a moment.", { code: "busy_queue" });
    if (!cur) throw refuse(409, "Nothing is playing on this pad - ▶ Play starts it now.", { code: "nothing_on" });
    // a running queue you may grow (yours, or a free one for a library admin): "+ Add to the queue that's playing" (edit op add)
    if (cur.q && (await mayGrow(user, cur.q))) throw refuse(409, "Your queue is playing on this pad - add to it.", { code: "queue_on" });
    const behind = String(cur.slot_id);
    const nowTitle = cur.title || null;
    const rows = await lineRows(R.id);
    const wait = rows.find((x) => x.user_id === user.userId && x.resume == null) || null;
    if (!wait && rows.some((x) => x.user_id === user.userId)) throw refuse(409, "Your queue is paused on this pad - it carries on after the booked stream.", { code: "queue_held" });
    if (wait) {
      const add = await build(b, { ...S, library_queue_max_items: 200, library_queue_max_hours: 24 });
      const room_ = S.library_queue_max_items - wait.items.length;
      if (room_ <= 0) throw refuse(409, `A queue holds at most ${S.library_queue_max_items} titles.`, { code: "queue_full" });
      let tot = totalSec(wait.items, Number((wait.prefs.req || {}).offset) || 0);
      // upnext2 review (function F3 / safety F5, 1.99alc): the pad's 📼 limit too, as the queue's start (launch) builds it - a grow past it was
      // cut there at the hand-over, the estimate no longer matched, and the whole queue was cancelled ("confirm it again")
      const capPad = await padCapSec(R.id, false), cap = Math.min(S.library_queue_max_hours * 3600, capPad);
      const put = [];
      for (const it of add.items.slice(0, room_)) {
        if (tot + it.duration > cap) break;
        put.push(it); tot += it.duration;
      }
      if (!put.length) {
        throw refuse(409, capPad < S.library_queue_max_hours * 3600 ? `That doesn't fit: titles on this pad's stage run at most ${Math.floor(capPad / 60)} minutes in a row.`
                                                                    : `A queue holds at most ${S.library_queue_max_hours} hours.`, { code: "queue_full" });
      }
      const before = estimate(wait.per_hour, totalSec(wait.items, Number((wait.prefs.req || {}).offset) || 0));
      const cost = Math.max(0, estimate(wait.per_hour, tot) - before);
      if (cost > 0) {
        if (b.estimate == null || b.estimate === "") throw refuse(400, `That adds about ${I().fmtPat(cost)} PAT, charged as it plays - confirm it to add it.`, { estimate: cost, code: "estimate" });
        if (Math.floor(Number(b.estimate)) !== cost) throw refuse(409, `It adds about ${I().fmtPat(cost)} PAT now - confirm it again.`, { estimate: cost, code: "estimate" });
      }
      wait.items.push(...put);
      await saveItems(wait);
      await runQuery("UPDATE media_queues SET prefs = ? WHERE id = ?", [JSON.stringify({ ...wait.prefs, est: (wait.prefs.est || 0) + cost }), wait.id]);
      await I().logControl(user, R.id, "queue_after", `+${put.length} title(s): ${fmtTitle(put[0])}`, { queue_id: wait.id });
      const ln = await lineFor(R.id);
      return { ok: true, after: true, queue_id: wait.id, added: put.length, items: wait.items.length, cost, behind: nowTitle, behind_queue: !!cur.q, behind_left: cur.q ? cur.left || 0 : 0,
               place: ln.findIndex((h) => h.row && h.row.id === wait.id) + 1, line: ln.length };
    }
    if (rows.filter((x) => x.resume == null).length >= AFTER_MAX) {
      throw refuse(409, `${AFTER_MAX} people are lined up after what's on already - try again when one has started.`, { code: "line_full", max: AFTER_MAX });
    }
    await I().preflight(user, A, R, { behind });
    const built = await build(b, S, await padCapSec(R.id, false));
    const pv = priceView(A, S, built.total_sec);
    if (pv.estimate > 0) {
      if (b.estimate == null || b.estimate === "") throw refuse(400, `This costs about ${I().fmtPat(pv.estimate)} PAT as it plays - confirm it to add it.`, { estimate: pv.estimate, code: "estimate" });
      if (Math.floor(Number(b.estimate)) !== pv.estimate) throw refuse(409, `The estimate is ${I().fmtPat(pv.estimate)} PAT now - confirm it again.`, { estimate: pv.estimate, code: "estimate" });
    }
    // upnext3 review (money, owner answer 3 "paid queue needs the first title's points at the press"): lining up is a press - without the points for
    // its first title's started hours it is refused now (nothing is taken; the hand-over asks again when its turn comes). Empty accounts can't fill
    // the line (AFTER_MAX) until their turn.
    if (pv.per_hour > 0) {
      const need = pv.per_hour * hoursNeeded(0, built.items[0].duration, built.offset), have = await balanceOf(user.userId);
      if (have < need) {
        throw refuse(402, `Lining it up takes ${I().fmtPat(need)} points (its first title's started hours - nothing is taken until it starts) and you have ${I().fmtPat(have)} - top up first.`,
                     { code: "pat", need, balance: have });
      }
    }
    const t = NOW();
    const req = { quality: b.quality, audio: b.audio, sub: b.sub, offset: built.offset };
    const ins = await runQuery(`INSERT INTO media_queues (room_id, user_id, username, access, state, items, pos, prefs, scope, per_hour, paid_hours, played_sec,
                                  slot_id, created, updated, behind) VALUES (?, ?, ?, ?, 'after', ?, 0, ?, ?, ?, 0, 0, NULL, ?, ?, ?)`,
                               [R.id, user.userId, user.username, A.how, JSON.stringify(built.items), JSON.stringify({ req, est: pv.estimate }), built.scope, pv.per_hour,
                                t, t, behind]);
    await I().logControl(user, R.id, "queue_after", `${built.items.length} title(s) after "${nowTitle || "?"}": ${fmtTitle(built.items[0])}`, { queue_id: ins.id });
    const ln = await lineFor(R.id);
    const place = ln.findIndex((h) => h.row && h.row.id === ins.id) + 1;
    console.log(`[mediaqueue] ${user.username} (${A.how}) queued ${built.items.length} title(s) behind "${nowTitle}" on ${R.id} - after-queue #${ins.id}, ${place} of ${ln.length} in line` +
                (pv.per_hour ? `, est. ${pv.estimate} PAT` : ", free"));
    try { stage.stageBump(R.id); } catch (e) { /* the 2 s cache: pages see it then */ }
    return { ok: true, after: true, queue_id: ins.id, added: built.items.length, items: built.items.length, total_sec: built.total_sec, estimate: pv.estimate,
             per_hour: pv.per_hour, title: fmtTitle(built.items[0]), behind: nowTitle, behind_queue: !!cur.q, behind_left: cur.q ? cur.left || 0 : 0, place, line: ln.length };
  });
}
/** (inside the pad's lock) What an after-queue waited for is gone (⏹, a replace, a Cut): it ends, its owner gets a notice. slotId = only the
 *  one behind that slot (null: any). Never throws. -> ended one? */
async function cancelAfter(roomId, why, slotId = null) {
  try {
    let n = 0;
    for (const w of await lineRows(roomId)) if ((!slotId || String(w.behind) === String(slotId)) && (await cancelRow(w, why))) n++;
    if (n) { try { stage.stageBump(roomId); } catch (e) { /* the 2 s cache: pages see it then */ } }   // (upnext2 review: the lower-third's UP NEXT goes)
    return n > 0;
  } catch (e) { console.error("[mediaqueue] after:", conf.errLine(e)); return false; }
}
/** upnext2 review (safety F4, 1.99alc): "✕ Take my titles out" - the titles someone added behind a single title come out before they start (they
 *  bill their owner per hour whenever it starts, maybe hours later). Their owner, or whoever may control them (the pad's owner, site staff,
 *  a library admin - medialib.mayControl); someone else taking them out leaves their owner a notice. Nothing was ever charged. */
// upnext3 (1.99ali): which row of the line - `id` (the 📼 player's ✕ next to it), else your own, else (an older page) the first one
async function withdrawAfter(user, room, id = null) {
  await L().init();
  if (!user || !user.userId) throw refuse(401, "Sign in first.", { code: "signin" });
  const R = await I().roomOf(room);
  if (!R || !(await stage.seesPad(user, R.id))) throw refuse(404, "No such pad.", { code: "pad" });
  return withLock(R.id, async () => {
    const rows = await lineRows(R.id);
    const want = id != null && id !== "" && Number.isInteger(Number(id)) ? Number(id) : null;
    const w = want != null ? rows.find((x) => Number(x.id) === want) || null : rows.find((x) => x.user_id === user.userId) || rows.find((x) => x.resume == null) || null;
    if (!w) throw refuse(404, "Nothing is waiting to play after this.", { code: "nothing_after" });
    const own = w.user_id === user.userId;
    if (!own && !(await I().mayControl(user, R.id, w.user_id))) {
      throw refuse(403, "Only whoever added them, the pad's owner or an admin can take them out.", { code: "control_denied" });
    }
    const c = await runQuery("UPDATE media_queues SET state = 'ended', ended_at = ?, end_reason = ?, notice = ?, updated = ? WHERE id = ? AND state = 'after'",
                             [NOW(), `withdrawn by ${user.username}`.slice(0, 120), own ? null : "after_removed", NOW(), w.id]);
    if (!(c && c.changes)) throw refuse(409, "They've just started (or gone) - look again.", { code: "play_changed" });
    if (!own) {
      const pad = await padTitle(R.id);
      await require("./inbox").addSafe(w.user_id, { kind: "media", title: w.resume != null ? `📼 Your paused queue on ${pad} was taken out` : `📼 Your titles up next on ${pad} were taken out`,
        body: w.resume != null ? "The pad's owner or an admin took it out before it carried on - nothing more was charged."
                               : "The pad's owner or an admin took them out before they started - nothing was charged.", link: "/stage", ref: "mlibafter:" + w.id });
    }
    await I().logControl(user, R.id, "queue_remove", `${w.items.length} title(s) up next${own ? "" : ` (${w.username || "?"}'s)`}`, { queue_id: w.id });
    console.log(`[mediaqueue] after-queue #${w.id} on ${R.id} withdrawn by ${user.username}`);
    try { stage.stageBump(R.id); } catch (e) { /* the 2 s cache */ }
    return { ok: true, withdrawn: w.items.length };
  });
}
/** upnext2 review (safety F6): the single title carries on on a fresh slot (a seek / resume after media-control lost it, a long pause): the titles
 *  behind it wait behind the new slot (inside the pad's lock - medialib.restart_). Never throws. */
// (upnext3: also ▶ Play this instead - what's lined up waits behind the new title; and a hand-over - the rest wait behind the one that started)
async function moveAfter(roomId, fromSlot, toSlot) {
  if (!fromSlot || !toSlot) return;
  try {
    await runQuery("UPDATE media_queues SET behind = ?, retry_since = NULL, updated = ? WHERE room_id = ? AND state = 'after' AND behind = ?", [String(toSlot), NOW(), String(roomId), String(fromSlot)]);
  } catch (e) { console.error("[mediaqueue] after:", conf.errLine(e)); }
}
/** (inside the pad's lock - medialib.watchOne) The single title `s` ended by itself (how: finished / error): titles waiting behind it start -
 *  their owner's queue takes the stage over from that slot (launch with a system replace: the feature + the card carry, the station break).
 *  Their own rules apply again now (access, the pad, the cap, the price = the estimate they confirmed). -> started? */
// upnext3: the pad's line (handOver) - a waiting booking first, then a paused queue, then the people lined up
// medialib.stop / watchOne / fireBreak: `s` came off (how: finished / error / stopped / failed / lost; why = its play's end reason) -> {started, retired}
async function startAfter(s, how, pos, { why = null, reason = null, actor = null, error = null } = {}) {
  if (!(await lineFor(s.room_id).catch(() => [])).length) return { started: false, retired: false };
  const R = await I().roomOf(s.room_id);
  if (!R) return { started: false, retired: false };
  const rep = { slot_id: s.slot_id, s: { ...s, position: pos != null ? pos : s.position }, q: null, starter: null, by: s.by_user || null, title: s.title || null, left: 0,
                open: true, why: why || (how === "error" ? "error" : "finished"), error: error || null };
  return handOver(R, rep, { reason: reason || (how === "error" ? "library_error" : "library_done"), actor });
}

// ── views ──
async function balanceOf(userId) { const r = (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [userId]))[0]; return r ? r.b : 0; }
async function view(q, { withBalance = false } = {}) {
  const s = q.state === "active" ? await I().session(q.room_id) : null;
  const mine = s && Number(s.queue_id) === Number(q.id) ? s : null;
  const cur = q.items[q.pos] || null;
  const curLeft = mine ? Math.max(0, (mine.duration || (cur && cur.duration) || 0) - (mine.position || 0)) : cur ? cur.duration : 0;
  const curPlayed = mine ? Math.max(0, (mine.position || 0) - (mine.ep_offset || 0)) : 0;
  const after = q.items.slice(q.pos + 1);
  const leftSec = curLeft + totalSec(after);
  let estLeft = 0, nextCharge = 0;
  if (q.per_hour > 0 && q.state === "active") {
    const curFull = mine ? Math.max(0, (mine.duration || 0) - (mine.ep_offset || 0)) : cur ? cur.duration : 0;
    const need = Math.ceil((q.played_sec + curFull + totalSec(after)) / 3600);
    estLeft = Math.max(0, need - q.paid_hours) * q.per_hour;
    if (after.length) nextCharge = Math.max(0, hoursNeeded(q.played_sec + curFull, after[0].duration, 0) - q.paid_hours) * q.per_hour;
  }
  // upnext3: a queue paused for a booking - what carrying on from title pos costs on top of what it paid
  const held = q.state === "after" && q.resume != null;
  if (held && q.per_hour > 0) {
    const off = Math.max(0, Number(q.brk && q.brk.offset) || 0);
    estLeft = Math.max(0, Math.ceil((q.played_sec + totalSec(q.items.slice(q.pos), off)) / 3600) - q.paid_hours) * q.per_hour;
    if (cur) nextCharge = Math.max(0, hoursNeeded(q.played_sec, cur.duration, off) - q.paid_hours) * q.per_hour;
  }
  const v = { id: q.id, room: q.room_id, state: q.state, by: q.username, scope: q.scope, pos: q.pos, count: q.items.length,
              now: cur, next: after.slice(0, 60).map((it, k) => ({ ...it, index: q.pos + 1 + k })), left_sec: leftSec, played_sec: q.played_sec + curPlayed,
              per_hour: q.per_hour, paid_hours: q.paid_hours, est_left: estLeft, next_charge: nextCharge,
              waiting: q.state === "active" && !mine, retry_since: q.retry_since || null, starts_at: q.state === "active" && !mine && q.brk ? Number(q.brk.until) || null : null,
              notice: q.notice || null, end_reason: q.end_reason || null, ended_at: q.ended_at || null, created: q.created, ...(held ? { held: true } : {}) };
  if (withBalance && q.per_hour > 0) { v.balance = await balanceOf(q.user_id); v.low = nextCharge > 0 && v.balance < nextCharge; }
  return v;
}
/** {all} every active queue (admins) | {userId, recent} mine (+ ones that ended in the last few minutes) */
async function views({ all = false, userId = null, recent = false } = {}) {
  await L().init();
  let rows;
  if (all) rows = await getQuery("SELECT id FROM media_queues WHERE state = 'active' ORDER BY id");
  else if (userId) rows = await getQuery("SELECT id FROM media_queues WHERE user_id = ? AND (state IN ('active','after') OR (? AND ended_at > ?)) ORDER BY id DESC LIMIT 5",
                                         [userId, recent ? 1 : 0, NOW() - RECENT_MS]);
  else rows = [];
  const out = [];
  for (const r of rows) { const q = await load(r.id); if (q) out.push(await view(q, { withBalance: !!userId })); }
  return out;
}

// ── routes (medialib.register adds them; J = signed in + same-site POST + JSON) ──
function routes(app, { J, me, timers = true }) {
  if (timers) fastOn = true;
  app.post("/api/medialib/queue/preview", ...J(async (req) => preview(me(req), req.body || {})));
  // 1.99ajk plexchat: the pad check lives in startFor / bookFor (one rule source: these routes, Pepe's chat, the Room Dock)
  app.post("/api/medialib/queue/start", ...J(async (req) => startFor(me(req), req.body || {})));
  // 1.99lw: book a 📼 slot for later (one title or a queue), sized to its runtime
  app.post("/api/medialib/book", ...J(async (req) => bookFor(me(req), req.body || {})));
  app.post("/api/medialib/queue/next", ...J(async (req) => next(me(req), (req.body || {}).room)));
  app.post("/api/medialib/queue/prev", ...J(async (req) => prev(me(req), (req.body || {}).room)));
  app.post("/api/medialib/queue/edit", ...J(async (req) => edit(me(req), (req.body || {}).room, req.body || {})));
  // upnext2 (E): "+ Add to the queue" behind a single title (a queue of the adder's own that starts when it ends)
  app.post("/api/medialib/queue/after", ...J(async (req) => after(me(req), req.body || {})));
  // upnext2 review (safety F4, 1.99alc): "✕ Take my titles out" - before they start
  // (upnext3: {id} - one row of the line, the 📼 player's ✕ next to it; none = your own)
  app.post("/api/medialib/queue/after/cancel", ...J(async (req) => withdrawAfter(me(req), (req.body || {}).room, (req.body || {}).id)));
}

module.exports = { start, startFor, bookFor, addNext, mayGrow, addCost, addCostFor, nextEpisodeOf, preview, book, watchBookings, bookMinutes, BOOK_BUFFER_MIN, next, prev, stop, edit, views, viewOf: (q) => view(q), onWatch, watchIdle, restartCurrent, forRoomOf, activeFor, routes,
                   buildQueue, capQueue, totalSec, estimate, hoursNeeded, pickTracks, prefsFrom, sortEps, slim, SCOPES, _setClock,
                   _fast: (on) => { fastOn = !!on; },
                   breakDue, _now: () => NOW(),                                     // upnext2: the station break (medialib's clock is this one)
                   after, afterFor, cancelAfter, startAfter,                        // upnext2 (E): titles behind a single play
                   withdrawAfter, moveAfter,                                        // upnext2 review fixes (1.99alc)
                   lineFor, handOver, afterEnded, cancelLine, bookingDue, lineWaits, AFTER_MAX,     // upnext3 (1.99ali): the pad's line
                   _lock: withLock, _retire: retireForReplace };                    // plexreplace: medialib's replace (the pad's lock, a queue taken over)
