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
  return { ...r, items: parse(r.items, []), prefs: parse(r.prefs, {}) };
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
  if (S.library_queue === false && !(single && b.when === "later")) throw refuse(403, "Queues are switched off right now.");
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
  const it = item || await I().fetchItem(ref.key);
  if (!it || !["movie", "episode"].includes(it.type) || !it.file) throw refuse(400, "That title has no playable file.");
  const slot = await stage.getSlot(q.slot_id);
  if (!slot || slot.settled || !["waiting", "active"].includes(slot.status)) throw Object.assign(refuse(409, "The queue's slot has ended."), { slotGone: true });
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
    await undo(e.message);
    if (e && (e.status === 429 || e.status === 503)) e.busy = true;
    throw e;
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
  await runQuery("UPDATE media_queues SET pos = ?, updated = ?, retry_since = NULL WHERE id = ?", [i, t, q.id]);
  q.pos = i;
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

/** End a queue (inside the lock): the current title, the slot, the row. */
async function endQueue(q, reason, { notice = null, by = "system", stageReason = null } = {}) {
  const s = await I().session(q.room_id);
  if (s && Number(s.queue_id) === Number(q.id)) {
    const pos = await stopEncoder(q.room_id);
    await finishTitle(q, s, "stopped", { pos: pos != null ? pos : s.position, by: by === "system" ? null : by });
  } else {
    try { await I().call("POST", `/streams/${encodeURIComponent(stageName(q.room_id))}/stop`, {}); } catch (e) { /* best effort */ }
  }
  await stage.end(q.slot_id, stageReason || (reason === "finished" ? "library_done" : "library_stopped"), by).catch(() => {});
  await runQuery("UPDATE media_queues SET state = 'ended', ended_at = ?, end_reason = ?, notice = ?, updated = ? WHERE id = ? AND state IN ('active','starting')",
                 [NOW(), String(reason || "ended").slice(0, 120), notice, NOW(), q.id]);
  q.state = "ended";
  L()._keys.delete(q.room_id);
  console.log(`[mediaqueue] queue #${q.id} on ${q.room_id} ended: ${reason}`);
}

/** Start title `i`, else the next one that will (inside the lock). Never throws. */
async function goTo(q, i, { offset = 0 } = {}) {
  if (!conf.on.library()) { await endQueue(q, "Play from Plex was switched off"); return { ended: true }; }
  while (i >= 0 && i < q.items.length) {
    await runQuery("UPDATE media_queues SET pos = ?, updated = ? WHERE id = ?", [i, NOW(), q.id]);
    q.pos = i;
    if (q.fails >= MAX_FAILS) { await endQueue(q, `${q.fails} titles in a row didn't play`, { notice: "failed", stageReason: "library_error" }); return { ended: true }; }
    try {
      const r = await startTitle(q, i, { offset });
      await announce(q, r.title).catch(() => {});      // never throws; quick (a DB row + the bridge)
      return { ok: true, ...r };
    } catch (e) {
      if (e && e.outOfPat) {
        const prev = q.items[i - 1];
        await endQueue(q, "out of PAT", { notice: "out_of_pat", stageReason: "library_done" });
        outOfPatNotice(q, prev ? fmtTitle(prev) : null, e.need).catch(() => {});
        return { ended: true, out_of_pat: true };
      }
      if (e && e.slotGone) { await endQueue(q, "the slot ended"); return { ended: true }; }
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
    }
  }
  await endQueue(q, "finished");
  return { ended: true, finished: true };
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
      return true;
    }
    if (live === null) return false;                                   // can't see mediactl right now: change nothing
    if (m && String(m.ratingKey) !== String(s.rating_key)) m = undefined;
    if (!m) {
      if (s.state === "paused" && NOW() - s.updated < 60000) return false;
      // mediactl lost it (restarted): the same title again where it was
      if (q.restarts >= MAX_RESTARTS) { await endQueue(q, "lost (media-control keeps restarting)", { stageReason: "library_lost" }); return true; }
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
function restartCurrent(s, pos) {
  return withLock(s.room_id, async () => {
    const q = await load(s.queue_id);
    if (!q || q.state !== "active") throw refuse(404, "This queue has ended.");
    return resumeTitle(q, s, pos);
  });
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
      if (q && q.state === "starting") await endQueue(q, "didn't finish starting", { stageReason: "library_failed" });
    }).catch((e) => console.error("[mediaqueue] stale start:", conf.errLine(e)));
  }
  const qs = await getQuery(`SELECT id, room_id FROM media_queues q WHERE state = 'active'
                             AND NOT EXISTS (SELECT 1 FROM media_sessions s WHERE s.room_id = q.room_id)`);
  let n = 0;
  for (const r of qs) {
    await withLock(r.room_id, async () => {
      const q = await load(r.id);
      if (!q || q.state !== "active" || (await I().session(q.room_id))) return;
      const slot = await stage.getSlot(q.slot_id);
      if (!slot || slot.settled || slot.status === "ended") { await endQueue(q, "slot " + ((slot && slot.end_reason) || "ended")); n++; return; }
      if (q.retry_since && NOW() - q.retry_since > RETRY_MS) { await endQueue(q, "no free encoder", { notice: "no_encoder" }); n++; return; }
      await goTo(q, q.pos);
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
  if (S.library_queue === false) throw refuse(403, "Queues are switched off right now.");
  const R = await I().roomOf(b.room);
  if (!R) throw refuse(404, "No such pad.");
  return withLock(R.id, () => launch(user, A, R, b, null));
}
/**
 * (inside the pad's lock) Build, check, open the slot - or, for a booking, open ITS slot (mainstage.libraryActivate) -
 * and start the first title. booked = {slot_id} for a booked slot's start: its estimate was confirmed when it was booked.
 */
async function launch(user, A, R, b, booked) {
  const S = conf.get();
  {
    await I().preflight(user, A, R);
    const built = await build(b, S, await padCapSec(R.id, !!booked));
    const pv = priceView(A, S, built.total_sec);
    if (pv.estimate > 0 && !booked) {
      if (b.estimate == null || b.estimate === "") throw refuse(400, `This queue costs about ${I().fmtPat(pv.estimate)} PAT as it plays - confirm it to start.`, { estimate: pv.estimate });
      if (Math.floor(Number(b.estimate)) !== pv.estimate) throw refuse(409, `The estimate is ${I().fmtPat(pv.estimate)} PAT now - confirm it again.`, { estimate: pv.estimate });
    }
    if (!I().isLibAdmin(user) || pv.per_hour > 0) await I().needEncoder();
    const first = built.first && String(built.first.key) === built.items[0].key ? built.first : await I().fetchItem(built.items[0].key);
    if (!first || !["movie", "episode"].includes(first.type) || !first.file) throw refuse(400, "The first title has no playable file.");
    const o = {
      quality: [1080, 720, 480].includes(Number(b.quality)) ? Number(b.quality) : S.library_quality,
      audio: b.audio !== undefined && b.audio !== null && b.audio !== "" && (first.audio || []).some((a) => a.index === Number(b.audio)) ? Number(b.audio) : null,
      sub: b.sub !== undefined && b.sub !== null && b.sub !== "" && (first.subs || []).some((x) => x.index === Number(b.sub) && x.burnable) ? Number(b.sub) : null,
    };
    const prefs = prefsFrom(first, o);
    let opened;
    if (booked) {
      const key = await stage.libraryActivate(booked.slot_id, { title: "📼 " + fmtTitle(first), minutes: Math.ceil(built.total_sec / 60) + I().SLACK_MIN });
      const sl = await stage.getSlot(booked.slot_id);
      opened = { key, slot: { id: sl.id, stream: sl.stream, hls: null } };
    } else {
      opened = await stage.libraryOpen(user, { room: R.id, title: "📼 " + fmtTitle(first),
                                               minutes: Math.min(24 * 60, Math.ceil(built.total_sec / 60) + I().SLACK_MIN) });
    }
    L()._keys.set(R.id, opened.key);
    const t = NOW();
    const ins = await runQuery(`INSERT INTO media_queues (room_id, user_id, username, access, state, items, pos, prefs, scope, per_hour, paid_hours, played_sec,
                                  slot_id, created, updated, last_announce) VALUES (?, ?, ?, ?, 'starting', ?, 0, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
                               [R.id, user.userId, user.username, A.how, JSON.stringify(built.items), JSON.stringify(prefs), built.scope, pv.per_hour,
                                opened.slot.id, t, t, t]);
    const q = await load(ins.id);
    let r;
    try {
      r = await startTitle(q, 0, { offset: built.offset, item: first, tracks: { audio: o.audio, sub: o.sub } });
      // 'starting' until now: a watcher (this process or another one on the same DB) leaves a queue alone while it starts
      await runQuery("UPDATE media_queues SET state = 'active', updated = ? WHERE id = ? AND state = 'starting'", [NOW(), q.id]);
    } catch (e) {
      // the first title didn't start: nothing stays open, any charge already came back (startTitle)
      await stage.end(opened.slot.id, "library_failed", user.username).catch(() => {});
      await runQuery("UPDATE media_queues SET state = 'ended', ended_at = ?, end_reason = ? WHERE id = ?", [NOW(), "didn't start: " + String(e.message || "error").slice(0, 100), q.id]);
      L()._keys.delete(R.id);
      throw e;
    }
    console.log(`[mediaqueue] ${user.username} (${A.how}) queued ${built.items.length} titles (${built.scope}, ${Math.round(built.total_sec / 60)} min) on ${R.id} - queue #${q.id}` +
                (pv.per_hour ? `, est. ${pv.estimate} PAT` : ", free"));
    return { ok: true, queue_id: q.id, slot: { id: opened.slot.id, stream: opened.slot.stream, hls: opened.slot.hls }, title: r.title, price: r.price,
             items: built.items.length, total_sec: built.total_sec, truncated: built.truncated, estimate: pv.estimate, per_hour: pv.per_hour };
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
async function bookingsInit() {
  await runQuery(`CREATE TABLE IF NOT EXISTS media_bookings (slot_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT,
    req TEXT NOT NULL, start_at INTEGER NOT NULL, minutes INTEGER, items INTEGER, estimate INTEGER, state TEXT NOT NULL, queue_id INTEGER, error TEXT,
    created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  await runQuery("CREATE INDEX IF NOT EXISTS media_bookings_state ON media_bookings (state, start_at)");
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
  await runQuery(`INSERT INTO media_bookings (slot_id, room_id, user_id, username, req, start_at, minutes, items, estimate, state, created, updated)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`,
                 [r.slot.id, R.id, user.userId, user.username, JSON.stringify(req), r.slot.start_at, minutes, built.items.length, pv.estimate, t, t]);
  console.log(`[mediaqueue] ${user.username} booked 📼 ${built.items.length} title(s), ${minutes} min on ${R.id} for ${new Date(r.slot.start_at).toISOString()} (slot ${r.slot.id})`);
  return { ok: true, slot: r.slot, minutes, items: built.items.length, total_sec: built.total_sec, truncated: built.truncated, estimate: pv.estimate,
           status: r.slot.status, title };
}
async function bookingFailed(bk, why, slotEnd = true) {
  await runQuery("UPDATE media_bookings SET state = 'failed', error = ?, updated = ? WHERE slot_id = ? AND state = 'booked'", [String(why).slice(0, 200), NOW(), bk.slot_id]);
  if (slotEnd) await stage.end(bk.slot_id, "library_failed", "system").catch(() => {});
  const pad = await padTitle(bk.room_id);
  await require("./inbox").addSafe(bk.user_id, { kind: "media", title: `📼 Your booked Plex stream on ${pad} didn't start`,
    body: String(why).slice(0, 200), link: "/stage", ref: "mlibbook-fail:" + bk.slot_id });
  console.warn(`[mediaqueue] booking ${bk.slot_id} on ${bk.room_id} didn't start: ${why}`);
}
/** Booked 📼 slots whose time came: start them (called by watchIdle every tick). */
async function watchBookings() {
  await bookingsInit();
  const rows = await getQuery("SELECT * FROM media_bookings WHERE state = 'booked' AND start_at <= ?", [NOW()]);
  let n = 0;
  for (const bk of rows) {
    await withLock(bk.room_id, async () => {
      const cur = (await getQuery("SELECT * FROM media_bookings WHERE slot_id = ? AND state = 'booked'", [bk.slot_id]))[0];
      if (!cur) return;
      const slot = await stage.getSlot(bk.slot_id);
      if (!slot || slot.settled || slot.status === "ended") {
        await runQuery("UPDATE media_bookings SET state = 'cancelled', updated = ? WHERE slot_id = ?", [NOW(), bk.slot_id]);
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
      const req = parse(bk.req, {});
      try {
        const r = await launch(u, A, R, { ...req, room: R.id }, { slot_id: bk.slot_id });
        await runQuery("UPDATE media_bookings SET state = 'started', queue_id = ?, updated = ? WHERE slot_id = ?", [r.queue_id, NOW(), bk.slot_id]);
        console.log(`[mediaqueue] booking ${bk.slot_id} started as queue #${r.queue_id}`);
      } catch (e) {
        const windowMs = (stage.config().start_window_min || 10) * 60000;
        const transient = e && (e.status === 429 || e.status === 503 || e.status === 502 || e.busy);
        const sl = await stage.getSlot(bk.slot_id).catch(() => null);
        const stillBooked = sl && sl.status === "scheduled" && !sl.settled;
        if (transient && stillBooked && NOW() - bk.start_at < windowMs) return;   // no free encoder / unreachable: try again next tick
        await bookingFailed(bk, e && e.outOfPat ? "You're out of PAT - top up to keep watching." : (e && e.message) || "It couldn't start.");
      }
      n++;
    }).catch((e) => console.error("[mediaqueue] booking:", conf.errLine(e)));
  }
  return n;
}

// ── controls ──
async function needQueue(user, room) {
  await L().init();
  if (!user || !user.userId) throw refuse(401, "Sign in first.");
  const R = await I().roomOf(room);
  if (!R) throw refuse(404, "No such pad.");
  const q = await activeFor(R.id);
  if (!q) throw refuse(404, "There's no queue playing on this pad.");
  if (!(await canControl(user, q))) throw refuse(403, I().CONTROL_DENIED);
  return { R, q };
}
// 1.99lw: the starter, the library admins, the pad's owner (+ site staff) - medialib.mayControl
const canControl = (user, q) => I().mayControl(user, q.room_id, q.user_id);

async function step(user, room, dir) {
  const { R } = await needQueue(user, room);
  return withLock(R.id, async () => {
    const q = await activeFor(R.id);
    if (!q || !(await canControl(user, q))) throw refuse(404, "There's no queue playing on this pad.");
    const to = q.pos + dir;
    if (to >= q.items.length) throw refuse(409, "That's the last title - ⏹ Stop ends the queue.");
    if (to < 0) throw refuse(409, "That's the first title.");
    const s = await I().session(R.id);
    let r;
    if (s && Number(s.queue_id) === Number(q.id)) {
      const pos = await stopEncoder(R.id);
      r = await advance(q, s, dir > 0 ? "skipped" : "back", { pos: pos != null ? pos : s.position, by: user.username, to });
    } else r = await goTo(q, to);
    await I().logControl(user, R.id, dir > 0 ? "next" : "prev", q.items[to] ? fmtTitle(q.items[to]) : null, { queue_id: q.id });
    return { ok: true, ...r, pos: q.pos };
  });
}
const next = (user, room) => step(user, room, 1);
const prev = (user, room) => step(user, room, -1);

async function stop(user, q0, reason = "stopped") {
  if (!(await canControl(user, q0))) throw refuse(403, I().CONTROL_DENIED);
  return withLock(q0.room_id, async () => {
    const q = await load(q0.id);
    if (q && q.state === "active") await endQueue(q, `${reason} by ${user.username}`, { by: user.username });
    await I().logControl(user, q0.room_id, "stop", "the queue", { queue_id: q0.id });
    return { ok: true };
  });
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
      const add = await build({ keys: b.keys }, { ...S, library_queue_max_items: 200, library_queue_max_hours: 24 });
      const room_ = S.library_queue_max_items - q.items.length;
      if (room_ <= 0) throw refuse(409, `A queue holds at most ${S.library_queue_max_items} titles.`);
      const s = await I().session(R.id);
      const curLeft = s ? Math.max(0, (s.duration || 0) - (s.position || 0)) : 0;
      let left = curLeft + totalSec(q.items.slice(q.pos + 1));
      let added = 0;
      for (const it of add.items.slice(0, room_)) {
        if (left + it.duration > S.library_queue_max_hours * 3600) break;
        q.items.push(it); left += it.duration; added++;
      }
      if (!added) throw refuse(409, `A queue holds at most ${S.library_queue_max_hours} hours.`);
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
  const v = { id: q.id, room: q.room_id, state: q.state, by: q.username, scope: q.scope, pos: q.pos, count: q.items.length,
              now: cur, next: after.slice(0, 60).map((it, k) => ({ ...it, index: q.pos + 1 + k })), left_sec: leftSec, played_sec: q.played_sec + curPlayed,
              per_hour: q.per_hour, paid_hours: q.paid_hours, est_left: estLeft, next_charge: nextCharge,
              waiting: q.state === "active" && !mine, retry_since: q.retry_since || null,
              notice: q.notice || null, end_reason: q.end_reason || null, ended_at: q.ended_at || null, created: q.created };
  if (withBalance && q.per_hour > 0) { v.balance = await balanceOf(q.user_id); v.low = nextCharge > 0 && v.balance < nextCharge; }
  return v;
}
/** {all} every active queue (admins) | {userId, recent} mine (+ ones that ended in the last few minutes) */
async function views({ all = false, userId = null, recent = false } = {}) {
  await L().init();
  let rows;
  if (all) rows = await getQuery("SELECT id FROM media_queues WHERE state = 'active' ORDER BY id");
  else if (userId) rows = await getQuery("SELECT id FROM media_queues WHERE user_id = ? AND (state = 'active' OR (? AND ended_at > ?)) ORDER BY id DESC LIMIT 5",
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
  app.post("/api/medialib/queue/start", ...J(async (req) => {
    const b = { ...(req.body || {}) };
    const R = await I().roomOf(b.room);
    if (b.room && R && !(await stage.seesPad(req.user, R.id))) throw refuse(404, "No such pad.");
    return start(me(req), b);
  }));
  // 1.99lw: book a 📼 slot for later (one title or a queue), sized to its runtime
  app.post("/api/medialib/book", ...J(async (req) => {
    const b = { ...(req.body || {}) };
    const R = await I().roomOf(b.room);
    if (b.room && R && !(await stage.seesPad(req.user, R.id))) throw refuse(404, "No such pad.");
    return book(me(req), b);
  }));
  app.post("/api/medialib/queue/next", ...J(async (req) => next(me(req), (req.body || {}).room)));
  app.post("/api/medialib/queue/prev", ...J(async (req) => prev(me(req), (req.body || {}).room)));
  app.post("/api/medialib/queue/edit", ...J(async (req) => edit(me(req), (req.body || {}).room, req.body || {})));
}

module.exports = { start, preview, book, watchBookings, bookMinutes, BOOK_BUFFER_MIN, next, prev, stop, edit, views, viewOf: (q) => view(q), onWatch, watchIdle, restartCurrent, forRoomOf, activeFor, routes,
                   buildQueue, capQueue, totalSec, estimate, hoursNeeded, pickTracks, prefsFrom, sortEps, slim, SCOPES, _setClock,
                   _fast: (on) => { fastOn = !!on; } };
