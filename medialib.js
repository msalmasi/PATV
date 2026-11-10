// medialib.js — 1.99ji: 📼 Play from library. A movie or an episode from the homelab Plex library on a pad's stage.
// 1.99jn: PLEX USERS can do it too, for PAT, from the Go-live flow (/stage, "📼 Play from Plex").
//
// The homelab media-control service (deploy/mediactl, next to the files and the iGPU) does the Plex search and runs
// one `ffmpeg -re` per stage that pushes H.264 + AAC to the ordinary RTMP ingest with a 📼 LIBRARY SLOT's one-time key
// (mainstage.libraryOpen: no slot fee, as long as the title, one per pad). So the stage, HLS, WHEP, snaps and the Twitch
// relay all see an ordinary slot, and ending the slot (Cut, time up, a paused slot left too long) ends the stream.
//
// Calls to the service are signed (HMAC-SHA256 with MEDIACTL_SECRET - the same scheme as mediactl.js sign()) and,
// for https, the certificate is pinned by MEDIACTL_TLS_SHA256. The Plex token stays in the homelab.
//
// WHO (access()):
//   * site admins (library_allow = admins) or admins + staff (= staff): FREE, any pad, as before;
//   * 1.99jp: EVERY signed-in member while library_plex is on:
//       - PLEX MEMBERS play FREE: a Plex account linked to them that's on our Plex server and active (plexmembers.js),
//         or a username on the library_users override list; at most library_free_daily_cap plays a rolling day;
//       - everyone else pays library_price PAT per STARTED HOUR of what's left of the title (from the start point), at
//         most library_daily_cap paid plays a rolling day.
//     Both take the pad under the stage-slot rules (sees the pad, not banned there, no other open slot of their own, a
//     free slot in the pad), and only while mediactl has a free stream (MEDIACTL_MAX_STREAMS).
// MONEY (paid plays): shop.chargeService({hold}) debits the buyer and records a completed official order (their
// orders page), crediting nobody yet. Once the stream is ON the stage (the slot's went_live), the hold is ROUTED like
// any pad spend - boosts.routeInTx kind "library_play" (flow library_play): 50% Fort Knox / 50% that pad's room vault,
// 100% Fort Knox when the pad's owner plays on their own pad. If it never gets on the stage (the encoder or the slot
// fails, it's stopped first) the whole price is refunded (shop.refundService). Seek / pause / resume are free; a
// resume that needs a fresh slot carries the original charge.
// CONTROLS: the slot owner (who started it) and the admins: pause / resume / seek / stop - on /stage (the Go-live page's
// "Your slot" card) and /admin/media. The pad owner / staff can Cut it from the stage like any slot.
// Every play is logged (media_plays: who, what, pad, price, how it ended). Only show what we have the rights to show.
//
//   media_sessions   room_id -> the slot + play that pad's stage is running from the library
//   media_plays      the log (+ price, order_id, charge: free | held | routed | refunded | moved | carried | covered)
//   media_queues     1.99lr: 📼 QUEUES (mediaqueue.js) - a season / a series / a list played back to back in ONE slot
"use strict";
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const conf = require("./mediaconf");
const stage = require("./mainstage");
const rooms = require("./rooms");

const STAGING = !!process.env.STAGING;
const WATCH_MS = 10 * 1000;
const SLACK_MIN = 20;          // a library slot runs this much longer than what's left of the title
const DAY_MS = 24 * 3600 * 1000;
const OPEN_STATES = "('waiting','active')";

class Refuse extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.refuse = true; if (extra) this.extra = extra; }
}

// ── the media-control client ──
const env = (k) => String(process.env[k] || "").trim();
function signHeaders(secret, method, pathQ, body) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("base64url");
  const bh = crypto.createHash("sha256").update(body || "").digest("hex");
  const sig = crypto.createHmac("sha256", secret).update(`${ts}\n${nonce}\n${method}\n${pathQ}\n${bh}`).digest("hex");
  return { "x-mc-ts": ts, "x-mc-nonce": nonce, "x-mc-sig": sig };
}
const bare = (h) => String(h || "").replace(/^\[|\]$/g, "");      // "[::1]" -> "::1" for net/tls
const normFp = (s) => String(s || "").replace(/[^A-Fa-f0-9]/g, "").toUpperCase();
// a TLS socket whose certificate matched the pin, before a single byte of the request is written
function pinnedSocket(u, pin, timeout) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: bare(u.hostname), port: Number(u.port) || 443, rejectUnauthorized: false,
                            servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname }, () => {
      const fp = normFp((s.getPeerCertificate() || {}).fingerprint256);
      if (!fp || fp !== normFp(pin)) { s.destroy(); return reject(Object.assign(new Error("media-control certificate doesn't match MEDIACTL_TLS_SHA256"), { status: 502 })); }
      resolve(s);
    });
    s.setTimeout(timeout, () => s.destroy(new Error("timeout")));
    s.once("error", reject);
  });
}
/** -> {status, json} (or {status, body, type} with raw). Throws {status: 502/503} when it can't be reached. */
async function call(method, pathQ, body = null, { raw = false, timeout = 15000 } = {}) {
  const base = env("MEDIACTL_URL").replace(/\/+$/, ""), secret = env("MEDIACTL_SECRET");
  if (!base || secret.length < 32) throw new Refuse(503, "The media-control service isn't configured.", { code: "encoder_down" });
  const u = new URL(base + pathQ);
  const data = body == null ? "" : JSON.stringify(body);
  const headers = { ...signHeaders(secret, method, u.pathname + u.search, data), Accept: "application/json" };
  if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
  const pin = env("MEDIACTL_TLS_SHA256");
  const opts = { host: bare(u.hostname), port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method, headers, timeout };
  let mod = http;
  if (u.protocol === "https:") {
    // pinned: our own already-verified TLS socket under a plain http request; unpinned: ordinary CA-checked https
    if (pin) { const sock = await pinnedSocket(u, pin, timeout); opts.createConnection = () => sock; }
    else { mod = https; }
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, body: buf, type: res.headers["content-type"] });
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(Object.assign(new Error("The media-control service can't be reached (" + conf.errLine(e) + ")."), { status: 502, refuse: true })));
    if (data) req.write(data);
    req.end();
  });
}
// a JSON call that must succeed: its error message is shown to the user as-is (mediactl's messages are written for that)
async function must(method, pathQ, body) {
  const r = await call(method, pathQ, body);
  if (r.status === 401) throw new Refuse(502, "The media-control service refused our signature - check MEDIACTL_SECRET on both sides (and the clocks).");
  if (r.status >= 400 || !r.json || r.json.ok === false) throw new Refuse(r.status >= 400 && r.status < 500 ? r.status : 502, (r.json && r.json.error) || `media-control answered ${r.status}`);
  return r.json;
}

// mediactl stage name for a pad: prod and staging share the one service, so staging's are prefixed
function stageName(roomId) {
  const id = String(roomId || "");
  const base = /^[A-Za-z0-9._-]{1,70}$/.test(id) ? id : "r-" + crypto.createHash("sha1").update(id).digest("hex").slice(0, 16);
  return (STAGING ? "stg." : "") + base;
}

// ── storage ──
let ready = null;
async function addCol(table, def) {
  try { await runQuery(`ALTER TABLE ${table} ADD COLUMN ${def}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
function init() {
  if (!ready) {
    ready = (async () => {
      await conf.init();
      await stage.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS media_plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, username TEXT, room_id TEXT NOT NULL, slot_id TEXT,
        rating_key TEXT, title TEXT, kind TEXT, year INTEGER, duration INTEGER, quality INTEGER, offset_start INTEGER,
        audio INTEGER, sub INTEGER, ended_at INTEGER, end_reason TEXT, last_pos INTEGER, error TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS media_plays_ts ON media_plays (ts)");
      // 1.99jn: what the play cost and where that PAT is
      for (const def of ["price INTEGER NOT NULL DEFAULT 0", "order_id INTEGER", "charge TEXT", "settled_at INTEGER", "carried_from INTEGER", "access TEXT"]) {
        await addCol("media_plays", def);
      }
      // 1.99lr: 📼 queues (mediaqueue.js): which queue + place a play belongs to, and the started hours it was charged
      for (const def of ["queue_id INTEGER", "queue_pos INTEGER", "hours INTEGER"]) await addCol("media_plays", def);
      await runQuery("CREATE INDEX IF NOT EXISTS media_plays_user ON media_plays (user_id, ts)");
      await runQuery(`CREATE TABLE IF NOT EXISTS media_sessions (
        room_id TEXT PRIMARY KEY, slot_id TEXT NOT NULL, play_id INTEGER NOT NULL, rating_key TEXT, title TEXT, state TEXT NOT NULL,
        by_user TEXT, started INTEGER NOT NULL, updated INTEGER NOT NULL, position INTEGER, duration INTEGER)`);
      // 1.99lr: a queue's session: its queue, whether this title got going (its charge is routed, not refunded), where it started
      for (const def of ["queue_id INTEGER", "live INTEGER NOT NULL DEFAULT 0", "ep_offset INTEGER"]) await addCol("media_sessions", def);
      // upnext2: a single play in its station break (state 'break' until brk_until: the encoder starts then - medialib.fireBreak)
      await addCol("media_sessions", "brk_until INTEGER");
      await runQuery(`CREATE TABLE IF NOT EXISTS media_queues (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, user_id TEXT, username TEXT, access TEXT, state TEXT NOT NULL,
        items TEXT NOT NULL, pos INTEGER NOT NULL DEFAULT 0, prefs TEXT, scope TEXT,
        per_hour INTEGER NOT NULL DEFAULT 0, paid_hours INTEGER NOT NULL DEFAULT 0, played_sec INTEGER NOT NULL DEFAULT 0,
        slot_id TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT, notice TEXT,
        last_announce INTEGER, fails INTEGER NOT NULL DEFAULT 0, retry_since INTEGER, restarts INTEGER NOT NULL DEFAULT 0)`);
      await runQuery("CREATE INDEX IF NOT EXISTS media_queues_room ON media_queues (room_id, state)");
      // upnext2: a queue's title in its station break - {until, pos, offset, tracks} (mediaqueue.beginBreak / breakDue)
      await addCol("media_queues", "brk TEXT");
      // upnext2 (E): an after-queue (state 'after') waits behind the single play on this slot (mediaqueue.after / startAfter)
      await addCol("media_queues", "behind TEXT");
      // upnext3 (1.99alm): a queue PAUSED for a booking that came due (state 'after', resume = when; brk = where it carries on) - mediaqueue.holdQueue
      await addCol("media_queues", "resume INTEGER");
      // upnext2 review (safety F3, 1.99alc): its STARTER ended it in its own station break (⏹ / their own ▶ Play this instead) - a refunded /
      // never-charged play that still took the pad's stage for the break: it counts towards the daily cap (paidToday / freeToday)
      await addCol("media_plays", "brk_stop INTEGER");
      await addCol("media_queues", "brk_stop INTEGER");
      await runQuery("CREATE INDEX IF NOT EXISTS media_queues_user ON media_queues (user_id, created)");
      // 1.99lw: who pressed what on the 📼 controls (pause / seek / next / stop ...), shown in the panel to whoever may control it
      await runQuery(`CREATE TABLE IF NOT EXISTS media_controls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, room_id TEXT NOT NULL,
        user_id TEXT, username TEXT, action TEXT NOT NULL, detail TEXT, play_id INTEGER, queue_id INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS media_controls_room ON media_controls (room_id, ts)");
      stage.setLibraryIdle(conf.get().library_pause_max_min);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const keys = new Map();   // room id -> the slot's raw RTMP key (memory only; resume after a mediactl restart needs it)
// 1.99lr: an episode reads "Show — S2E5 Title" (the slot title, "now playing", Pepe's announcement)
const fmtTitle = (it) => (it.type === "episode" && it.show
  ? `${it.show} — S${it.season == null ? 0 : it.season}E${it.episode == null ? 0 : it.episode} ${it.title || ""}`.trim()
  : `${it.title}${it.year ? ` (${it.year})` : ""}`).slice(0, 72);
const fmtPat = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
// upnext: what the stage's "Coming up next" card may show of a title (mainstage.libraryUpNext cleans it again) - never a file path, a Plex
// URL or a token: the poster is a yes / no, fetched by the page through /api/medialib/poster/<key> (signed in) like the 📼 search's
const upNextInfo = (it) => ({ key: it && it.key != null ? String(it.key) : null, kind: it && it.type === "episode" ? "episode" : "movie", title: it ? it.title : null,
                              year: it ? it.year : null, show: it ? it.show : null, season: it ? it.season : null, episode: it ? it.episode : null, poster: !!(it && it.poster) });

// ── upnext2: the 📼 STATION BREAK (owner 2026-11-05: "when does the 'next up' card actually show? ... maybe items are just loading too fast?") ──
// The "Coming up next" card lived only from the up-next marker to the new stream's publish (goLive clears it) - 0.3-1.0 s on prod, against
// a 10 s page poll and a 4-10 s viewer delay: almost nobody ever saw it. Now every title change on a pad's stage - a fresh ▶ Play, ▶ Play this
// instead, a queue moving on, ⏭ / ⏮, a booked start - sets the marker FIRST and holds the next title's encoder for breakSec() seconds: the
// card is the pad's featured stage for that long (mainstage autoFeature: pending), then the encoder starts and the card hands over.
//   * single play: its session is state 'break' until brk_until (the play / its held charge exist from the press - one charge, refunded if
//     it never gets on, routed once it does - settle()); fireBreak() starts it under the pad's lock;
//   * a queue: no session in the break (as between two titles before), media_queues.brk = {until, pos, offset, tracks}; the queue's own
//     startTitle() runs when it's due (mediaqueue.breakDue) - its per-hour charge is taken then, never during the break.
// Race-safe: everything that changes the pad (⏹, ▶ Play this instead, ⏭ / ⏮, a seek, a Cut) works on the break like on a title that plays
// and the newest wins - a break that was overtaken finds its session / queue changed and does nothing; the start runs under the pad's lock
// (mediaqueue's) so it never meets a control half-way; never two encoders (the old one stops when the break begins). A timer fires the
// start on time; the watcher (every WATCH_MS) starts any break that is due - a server restart during a break still starts the title.
// Encoders: a single play in its break holds one (busyOf), like a queue between titles. No watch-minutes: the card is never captured.
const BREAK_SECS = [0, 5, 8, 15];
const bnow = () => require("./mediaqueue")._now();       // (the queue's clock - tests move it)
/** The station break on this pad, in seconds (0 = none): the pad's own setting (rooms.upnext_break), else the site's (library_break_sec);
 *  the site's switch (library_break) off = none anywhere. */
async function breakSec(roomId) {
  const S = conf.get();
  if (S.library_break === false) return 0;
  let own = null;
  try { const R = await rooms.get(String(roomId || "")); if (R && R.upnext_break != null) own = Number(R.upnext_break); } catch (e) { own = null; }
  const n = own != null ? own : Number(S.library_break_sec);
  return BREAK_SECS.includes(n) ? n : 8;
}
const brkTimers = new Map();      // room id -> the timer that starts its break's title on time (memory only; the watcher is the fallback)
let brkTimersOn = false;
function armBreak(roomId, until) {
  if (!brkTimersOn) return;
  const id = String(roomId);
  clearTimeout(brkTimers.get(id));
  const h = setTimeout(() => { if (brkTimers.get(id) === h) brkTimers.delete(id); breakDue(id).catch((e) => console.error("[medialib] break:", conf.errLine(e))); },
                       Math.max(0, Number(until) - bnow()) + 30);
  if (h.unref) h.unref();
  brkTimers.set(id, h);
}
/** A break on this pad may be due: its title starts now (a single play's or a queue's). -> started / ended something? */
async function breakDue(roomId) {
  await init();
  const s = await session(roomId);
  if (s && s.state === "break") return require("./mediaqueue")._lock(String(roomId), () => fireBreak(String(roomId), s.play_id));
  return require("./mediaqueue").breakDue(roomId);
}
// ── upnext2 (D): what's COMING on a pad's 📼 stage - the page's "UP NEXT" lower-third (in the last minute of a title that plays, with a
// countdown), "COMING UP AT <time>" (a booked 📼 start soon) and the off-air slate. -> {ends_at, next, at} | null - server facts only, never who
// queued it, no poster key (mainstage.comingOf caches it):
//   ends_at  when the 📼 title on now ends (its last known position + the time since; null while paused / in a break)
//   next     the title after it: a queue's next title, else (nothing on) a booked 📼 start's first title
//   at       that booking's start time (only when nothing from the library is on the pad)
const COMING_BOOK_MS = 60 * 60 * 1000;
// (upnext2 review, safety F7 1.99alc: no poster key - the lower-third and the slate draw none; it only made every signed-in viewer's poll read
// the sign-in for the length of a title. The page's ✕ remembers a title by its name)
function comingInfo(it) {
  if (!it) return null;
  const ep = it.type === "episode" || it.kind === "episode";
  return { kind: ep ? "episode" : "movie", title: it.title || null, year: it.year || null, show: ep ? it.show || null : null,
           season: ep && it.season != null ? it.season : null, episode: ep && it.episode != null ? it.episode : null };
}
async function comingFor(roomId) {
  await init();
  const id = String(roomId || "");
  const s = await session(id);
  const q = await require("./mediaqueue").activeFor(id);
  const out = { ends_at: null, next: null, at: null };
  if (s && s.state === "playing" && Number(s.duration) > 0) {
    out.ends_at = Math.round(Number(s.updated) + Math.max(0, Number(s.duration) - (Number(s.position) || 0)) * 1000);
  }
  // upnext3 (1.99alm): what's next after the title on now - a booking whose time came (it plays right after this title, the rest of the queue after
  // it - unless the queue is a booked one itself), else the queue's next title, else (a single title / a queue's last title) the line's head
  const lineAll = s || q ? await require("./mediaqueue").lineFor(id).catch(() => []) : [];
  const head = s ? lineAll[0] || null : null;
  const headNext = head && head.first ? comingInfo(head.first) : null;
  if (s && q && Number(s.queue_id) === Number(q.id)) {
    const booked = head && head.kind === "booking" ? (await safeQuery("SELECT 1 FROM media_bookings WHERE queue_id = ? LIMIT 1", [q.id])).length > 0 : false;
    out.next = head && head.kind === "booking" && !booked ? headNext : q.items[q.pos + 1] ? comingInfo(q.items[q.pos + 1]) : headNext;
  }
  if (s && !q) out.next = headNext;                                       // (upnext2 E: titles behind a single title)
  if (out.next && headNext && out.next === headNext) out.queued = true;   // (upnext3: it is the line's - a Cut of this title starts it; stage-room's confirm)
  // upnext3 review (ux 2 / 3): whenever anyone is lined up - how many, what kind is first, how many a cleared stage keeps (a booking, a queue paused
  // for one) - a Cut of what's on starts the line even while a queue still has titles (stage-room's confirm). Counts only, never who.
  if (lineAll.length) { out.line = lineAll.length; out.line_head = lineAll[0].kind; out.line_kept = lineAll.filter((h) => h.kind !== "after").length; }
  if (!s && !q) {
    const now = Date.now();
    const bk = (await safeQuery(`SELECT b.start_at, b.req, b.first, sl.title FROM media_bookings b JOIN stage_slots sl ON sl.id = b.slot_id
                                 WHERE b.room_id = ? AND b.state = 'booked' AND sl.status = 'scheduled' AND sl.settled = 0 AND b.start_at > ? AND b.start_at <= ?
                                 ORDER BY b.start_at LIMIT 1`, [id, now - 60000, now + COMING_BOOK_MS]))[0];
    if (bk) {
      let first = null;
      try { first = bk.first ? JSON.parse(bk.first) : null; } catch (e) { first = null; }
      // (a booking from before upnext2 has no `first`: the slot's own title, "📼 <title> +N")
      out.next = first ? comingInfo(first) : { kind: "movie", title: String(bk.title || "").replace(/^📼\s*/, "").replace(/\s\+\d+$/, "") || null,
                                                year: null, show: null, season: null, episode: null };
      out.at = Number(bk.start_at);
    }
  }
  return out.ends_at || (out.next && (out.next.title || out.next.show)) || out.at ? out : null;
}
const BREAK_RETRY_MS = 5000, BREAK_GIVEUP_MS = 90 * 1000;
/** upnext2 review (safety F12): media-control plays `ratingKey` on this pad's stage right now (its own list) */
async function encoderHas(roomId, ratingKey) {
  const live = await streamsNow();
  const m = live ? live.find((x) => x.stage === stageName(roomId)) : null;
  return !!(m && ["playing", "paused"].includes(m.state) && String(m.ratingKey) === String(ratingKey));
}
/** (inside the pad's lock) A single play's break is over: its encoder starts. Only the play this was for, still in its break: a control that
 *  moved the pad on meanwhile (⏹, a replace, a Cut) wins and nothing starts. No free encoder / media-control unreachable: tried again every
 *  BREAK_RETRY_MS for BREAK_GIVEUP_MS; anything else (or giving up) ends the slot and refunds a held charge (dropSession -> settle). */
async function fireBreak(roomId, playId) {
  const s = await session(roomId);
  if (!s || s.state !== "break" || Number(s.play_id) !== Number(playId)) return false;
  const t = bnow();
  if (Number(s.brk_until) > t + 50) { armBreak(roomId, Number(s.brk_until)); return false; }
  const Qm = require("./mediaqueue");
  const slot = await stage.getSlot(s.slot_id);
  if (!slot || slot.settled || !["waiting", "active"].includes(slot.status)) {
    await dropSession(s, "slot " + ((slot && slot.end_reason) || "ended"), s.position);
    // upnext3 (1.99alm, item 7): a Cut / time-up in the break - what's lined up behind it starts next (their station break, their title); a cut of
    // the whole pad, a cut + ban or a ban cleared the stage: it doesn't (mediaqueue.afterEnded - one rule for every path)
    await Qm.afterEnded(roomId, slot || s.slot_id);
    return true;
  }
  // upnext2 review (S13): Play from Plex switched off during the break - it doesn't start (a queue's next title doesn't either - goTo)
  if (!conf.on.library()) {
    await stage.end(s.slot_id, "library_stopped", "system").catch(() => {});
    await dropSession(s, "Play from Plex was switched off", s.position);
    await Qm.cancelLine(roomId, "Play from Plex was switched off");
    return true;
  }
  const p = (await getQuery("SELECT * FROM media_plays WHERE id = ?", [s.play_id]))[0] || {};
  let key = keys.get(String(roomId));
  if (!key) { key = await stage.libraryRekey(s.slot_id); if (key) keys.set(String(roomId), key); }   // (the site restarted during the break)
  try {
    if (!key) throw new Refuse(409, "The slot has ended.");
    await must("PUT", `/streams/${encodeURIComponent(stageName(roomId))}`, { rtmp: stage.RTMP_PUBLIC, key, ratingKey: String(s.rating_key),
      offset: Math.max(0, Number(s.position) || 0), quality: p.quality || conf.get().library_quality,
      audio: p.audio == null ? null : p.audio, sub: p.sub == null ? null : p.sub, title: s.title });
  } catch (e) {
    if (e && [429, 502, 503].includes(e.status) && t - Number(s.started) < BREAK_GIVEUP_MS) {
      const again = t + BREAK_RETRY_MS;
      await runQuery("UPDATE media_sessions SET brk_until = ? WHERE room_id = ? AND play_id = ? AND state = 'break'", [again, roomId, s.play_id]);
      console.warn(`[medialib] ${roomId}: "${s.title}" waits for an encoder after its station break (${conf.errLine(e)})`);
      armBreak(roomId, again);
      return false;
    }
    // upnext2 review (safety F12, 1.99alc): 409 "already playing" = an earlier start of THIS title got there (the site restarted while its
    // request was on the way, and the watcher asked again) - inside the pad's lock nothing else starts this stage: it's ours, it plays
    if (!(e && e.status === 409 && (await encoderHas(roomId, s.rating_key)))) {
      console.warn(`[medialib] ${roomId}: "${s.title}" didn't start after its station break: ${conf.errLine(e)}`);
      // upnext3 (item 7): whoever is lined up behind it takes the stage over now (the swap: the feature + the card carry) - it isn't their fault
      const h = await Qm.startAfter(s, "failed", s.position, { why: "didn't start", reason: "library_failed", error: conf.errLine(e) });
      if (!h.retired) {
        await stage.end(s.slot_id, "library_failed", "system").catch(() => {});
        await dropSession(s, "didn't start", s.position, conf.errLine(e));
      }
      return true;
    }
    console.log(`[medialib] ${roomId}: "${s.title}" was already on media-control after its station break - kept`);
  }
  await runQuery("UPDATE media_sessions SET state = 'playing', brk_until = NULL, updated = ? WHERE room_id = ? AND play_id = ? AND state = 'break'",
                 [Date.now(), roomId, s.play_id]);
  console.log(`[medialib] ${roomId}: "${s.title}" starts after its station break - play #${s.play_id}`);
  return true;
}

// ── who may play (1.99jn) ──
async function safeQuery(sql, args) { try { return await getQuery(sql, args); } catch (e) { return []; } }
/** The store's Plex invite item to point people at: the shortest timed one (else the first). */
function inviteItemLink() {
  const items = Object.entries(conf.get().invite_items || {});
  if (!items.length) return "/shop";
  items.sort((a, b) => ((a[1].days || 1e9) - (b[1].days || 1e9)));
  return "/shop/item/" + encodeURIComponent(items[0][0]);
}
/**
 * Is this account a PLEX USER right now (1.99jp: on our Plex server)? -> {how: override|plex, until (ms, null = no end)} | null.
 * The admin's override list, else a Plex account linked to it that's on the server and still active (plexmembers.js).
 */
async function plexUser(user, t = Date.now()) {
  if (!user || !user.userId) return null;
  const S = conf.get();
  const over = String(S.library_users || "").split(",").filter(Boolean);
  if (user.username && over.includes(String(user.username).toLowerCase())) return { how: "override", until: null };
  let m = null;
  try { m = await require("./plexmembers").memberFor(user.userId, t); } catch (e) { m = null; }
  return m ? { how: "plex", until: m.expires == null ? null : m.expires, plex: m.username, access: m.access } : null;
}
/**
 * May `user` play from the library, and on what terms? 1.99jp: every signed-in member may while library_plex is on -
 * Plex members free (their own daily cap), everyone else for library_price per started hour.
 * -> {ok, free, how: admin|staff|override|plex|paid, until, why: signin|off|null, message, hint}
 */
async function access(user) {
  await conf.init();
  const S = conf.get();
  if (!user || !user.userId) return { ok: false, free: false, how: null, why: "signin", message: "Sign in first." };
  if (conf.libraryAllowed(user)) {
    if (!conf.on.library()) return { ok: false, free: true, how: "admin", why: "off", message: conf.keys().mediactl ? "Play from library is switched off (/admin/media)." : "The media-control service isn't configured yet." };
    return { ok: true, free: true, how: SP.can(user, "media.library_free") ? "admin" : "staff", until: null, why: null, message: null };
  }
  if (!S.library_plex || !conf.on.library()) return { ok: false, free: false, how: null, why: "off", message: "Playing from Plex isn't open right now." };
  const p = await plexUser(user);
  if (p) return { ok: true, free: true, how: p.how, until: p.until, plex: p.plex || null, why: null, message: null };
  return { ok: true, free: S.library_price <= 0, how: "paid", until: null, why: null, message: null, hint: inviteItemLink() };
}
const isMemberHow = (how) => how === "plex" || how === "override";
/** What the Go-live page draws for the 📼 choice: every signed-in member while it's open (the price is per user: free for
 *  Plex members / admins, library_price per started hour for the rest); admins also see it, disabled, while it's off. */
async function goLiveInfo(user) {
  if (!user || !user.userId) return null;
  const A = await access(user);
  const S = conf.get();
  const member = isMemberHow(A.how);
  return { show: A.ok || (A.why === "off" && A.free), ok: A.ok, free: A.free, how: A.how, why: A.why, member, admin: A.how === "admin" || A.how === "staff",
           message: A.message, hint: A.hint || null, price_per_hour: A.free ? 0 : S.library_price,
           daily_cap: member ? S.library_free_daily_cap : A.free ? null : S.library_daily_cap,
           quality: S.library_quality, pause_max_min: S.library_pause_max_min,
           queue: S.library_queue !== false, queue_max_hours: S.library_queue_max_hours };   // 1.99lr: 📼 queues
}
/** PAT for a play: library_price per STARTED hour of what's left of the title from `offset` (at least one hour). */
function priceFor(durationSec, offsetSec, S = conf.get()) {
  const per = Math.max(0, Math.floor(Number(S.library_price) || 0));
  if (!per) return { price: 0, hours: 0, per_hour: 0 };
  const left = Math.max(0, (Number(durationSec) || 0) - Math.max(0, Number(offsetSec) || 0));
  const hours = Math.max(1, Math.ceil(left / 3600));
  return { price: per * hours, hours, per_hour: per };
}
// 1.99lr: a 📼 QUEUE is ONE play towards the daily caps, however many titles it plays
const PLAY_ONE = "COUNT(DISTINCT CASE WHEN queue_id IS NULL THEN 'p' || id ELSE 'q' || queue_id END)";
// (a log from before 1.99lr has no queue_id column yet: every row is its own play)
async function countPlays(where, args) {
  try { const r = await getQuery(`SELECT ${PLAY_ONE} AS n FROM media_plays WHERE ${where}`, args); return (r[0] && r[0].n) || 0; }
  catch (e) { const r = await safeQuery(`SELECT COUNT(*) AS n FROM media_plays WHERE ${where}`, args); return (r[0] && r[0].n) || 0; }
}
// upnext2 review (safety F2 / F3, 1.99alc): a play or a queue its starter ended in its own station break counts towards the daily cap - the
// break is 5-15 s of the pad's featured stage ("Coming up next") with nothing charged (a single play's hold is refunded, a queue charges when
// its title starts): pressing ▶ and ⏹ again and again took the stage over without limit. A queue that already started a title counts once
// through its plays (NOT EXISTS); one ended by someone else (the pad's owner, a Cut) never counts against its starter.
async function brkQueues(userId, t, paid) {
  const r = await safeQuery(`SELECT COUNT(*) AS n FROM media_queues q WHERE q.user_id = ? AND q.created > ? AND q.brk_stop = 1 AND ${paid ? "q.per_hour > 0" : "q.per_hour = 0 AND q.access IN ('plex','override')"}
                             AND NOT EXISTS (SELECT 1 FROM media_plays p WHERE p.queue_id = q.id)`, [userId, t - DAY_MS]);
  return (r[0] && r[0].n) || 0;
}
async function paidToday(userId, t = Date.now()) {
  return (await countPlays("user_id = ? AND ts > ? AND (charge IN ('held','routed') OR (brk_stop = 1 AND price > 0))", [userId, t - DAY_MS])) + (await brkQueues(userId, t, true));
}
// 1.99jp: a Plex member's free plays in the last 24 h (a resume on a fresh slot carries its play: not counted again)
async function freeToday(userId, t = Date.now()) {
  return (await countPlays("user_id = ? AND ts > ? AND charge = 'free' AND access IN ('plex','override') AND carried_from IS NULL", [userId, t - DAY_MS])) +
         (await brkQueues(userId, t, false));
}
/** upnext2 review (S3): the play `playId` was ended in its own station break by `user` - its starter's own ⏹ / replace marks it (the cap) */
async function markBrkStop(playId, user) {
  try { await runQuery("UPDATE media_plays SET brk_stop = 1 WHERE id = ? AND user_id = ?", [playId, user && user.userId ? user.userId : "-"]); }
  catch (e) { /* the cap is best effort; the play itself is settled */ }
}
async function mustAccess(user) {
  const A = await access(user);
  // 1.99ajk plexchat: + a stable code (signin | off) for Pepe's chat answers (plexchat.js) - the browser's text is unchanged
  if (!A.ok) throw new Refuse(A.why === "signin" ? 401 : 403, A.message, { ...(A.hint ? { hint: A.hint } : {}), code: A.why === "signin" ? "signin" : "off" });
  return A;
}
// the admins (library_allow) control every library stream; anyone else only the ones they started
const isLibAdmin = (user) => conf.libraryAllowed(user);

async function session(roomId) { return (await getQuery("SELECT * FROM media_sessions WHERE room_id = ?", [String(roomId)]))[0] || null; }
async function closePlay(playId, reason, pos, error) {
  await runQuery("UPDATE media_plays SET ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?), last_pos = COALESCE(?, last_pos), error = COALESCE(?, error) WHERE id = ?",
                 [Date.now(), reason, pos == null ? null : Math.round(pos), error || null, playId]);
  // 1.99nj: a play that ended may complete a 📼 Plex-on-pads achievement (plexpad.js; fire-and-forget, never blocks)
  try {
    const p = (await getQuery("SELECT user_id FROM media_plays WHERE id = ?", [playId]))[0];
    if (p && p.user_id) require("./achievements").poke(p.user_id);
  } catch (e) { /* achievements never block */ }
}

// ── the money (1.99jn) ──
/**
 * Settle a held charge: on the stage (wentLive) -> route it (Fort Knox / the pad's room vault); never got there -> refund.
 * Idempotent: only a play whose charge is still 'held' moves, and each of its two ways claims it first.
 */
async function settle(playId, wentLive, why) {
  const p = (await getQuery("SELECT * FROM media_plays WHERE id = ?", [playId]))[0];
  if (!p || p.charge !== "held" || !(p.price > 0)) return null;
  if (wentLive) {
    const boosts = require("./boosts");
    await boosts.init();
    const RS = await rooms.stageSettings(p.room_id).catch(() => null);
    const ownerSelf = !!(RS && RS.owner && RS.owner.userId === p.user_id);
    const row = await boosts.tx(async () => {
      const c = await runQuery("UPDATE media_plays SET charge = 'routed', settled_at = ? WHERE id = ? AND charge = 'held'", [Date.now(), p.id]);
      if (!c.changes) return null;
      if (p.order_id) await runQuery("UPDATE shop_orders SET seller_paid = 1, updated = ? WHERE id = ? AND seller_paid = 0", [Date.now(), p.order_id]);
      return boosts.routeInTx({ ref: "library:" + p.id, kind: "library_play", room_id: p.room_id, payer_id: p.user_id, payer_name: p.username,
        amount: p.price, owner_self: ownerSelf, via: "web", flow: "library_play", detail: `📼 ${p.title || ""}`.slice(0, 120) });
    });
    if (row) {
      try { boosts.telemetry(row, p.username, "web"); } catch (e) { /* telemetry only */ }
      try { await require("./shop").event(p.order_id, "completed", "system", `On the stage - routed: Fort Knox ${fmtPat(row.fortknox)}, room vault ${fmtPat(row.room_vault)}`); } catch (e) { /* log only */ }
      console.log(`[medialib] play #${p.id}: ${p.price} PAT routed (Fort Knox ${row.fortknox}, room vault ${row.room_vault}${ownerSelf ? ", owner's own pad" : ""})`);
    }
    return row ? "routed" : null;
  }
  const c = await runQuery("UPDATE media_plays SET charge = 'refunding' WHERE id = ? AND charge = 'held'", [p.id]);
  if (!c.changes) return null;
  let ok = false;
  try { ok = p.order_id ? await require("./shop").refundService(p.order_id, `📼 it never got on the stage (${why || "failed"})`, "system") : false; }
  catch (e) { console.error(`[medialib] play #${p.id}: refund failed:`, conf.errLine(e)); }
  await runQuery("UPDATE media_plays SET charge = ?, settled_at = ? WHERE id = ?", [ok ? "refunded" : "refund_failed", Date.now(), p.id]);
  if (ok) {
    require("./inbox").addSafe(p.user_id, { kind: "media", title: `📼 ${p.title} didn't start - refunded`,
      body: `It never got on the stage, so the ${fmtPat(p.price)} PAT came straight back.`, link: "/stage", ref: "mlib-refund:" + p.id }).catch(() => {});
  } else console.error(`[medialib] play #${p.id}: ${p.price} PAT NOT refunded (order ${p.order_id}) - check it by hand`);
  return ok ? "refunded" : "refund_failed";
}

async function dropSession(s, reason, pos, error) {
  await runQuery("DELETE FROM media_sessions WHERE room_id = ? AND slot_id = ?", [s.room_id, s.slot_id]);
  keys.delete(s.room_id);
  await closePlay(s.play_id, reason, pos, error);
  const slot = await stage.getSlot(s.slot_id).catch(() => null);
  await settle(s.play_id, !!(slot && slot.went_live), reason).catch((e) => console.error("[medialib] settle:", conf.errLine(e)));
}
const roomOf = async (v) => {
  const id = String(v || "");
  if (!id) return null;
  // 1.99??: an unregistered house room reads as Pepe's home pad (its registry title is the name whenever it has a row)
  return (await rooms.bySlug(id)) || (await rooms.get(id)) || (id === rooms.HOUSE_ROOM ? { id, title: "Pepe's home pad" } : null);
};

// ── actions ──
async function search(user, q) {
  await mustAccess(user);
  q = String(q || "").trim().slice(0, 100);
  if (q.length < 2) throw new Refuse(400, "Type at least 2 characters.", { code: "bad" });
  return (await must("GET", `/search?q=${encodeURIComponent(q)}&limit=24`)).results || [];
}
async function fetchItem(key) {
  if (!/^\d{1,12}$/.test(String(key))) throw new Refuse(400, "Bad item.");
  return (await must("GET", `/item/${key}`)).item;
}
async function item(user, key) {
  const A = await mustAccess(user);
  const it = await fetchItem(key);
  // the price at the start (the page re-prices for another start point with the same rule)
  if (it && ["movie", "episode"].includes(it.type)) it.pricing = { ...(A.free ? { price: 0, hours: 0, per_hour: 0 } : priceFor(it.duration, 0)), free: A.free };
  if (it && !isLibAdmin(user)) delete it.file;                        // file paths are for the admins' eyes
  return it;
}
// upnext review (privacy N1): a title change on a pad's stage has every signed-in viewer's "Coming up next" card ask for the same poster at
// once - site -> mediactl -> Plex's photo transcoder each time. A poster is the same picture for everyone: kept here a while by rating key (and
// one fetch in flight per key). Access is still checked per request; only the picture's bytes are shared.
const POSTER_TTL_MS = 10 * 60 * 1000, POSTER_MAX = 64, POSTER_MAX_BYTES = 512 * 1024;
const posterCache = new Map(), posterWait = new Map();     // key -> {at, status, body, type} / key -> Promise
async function poster(user, key) {
  await mustAccess(user);
  if (!/^\d{1,12}$/.test(String(key))) throw new Refuse(400, "Bad item.");
  const k = String(key), t = Date.now(), hit = posterCache.get(k);
  let r = hit && t - hit.at < POSTER_TTL_MS ? hit : null;
  if (hit && !r) posterCache.delete(k);
  if (!r) {
    let p = posterWait.get(k);
    if (!p) {
      p = call("GET", `/poster/${k}`, null, { raw: true }).finally(() => posterWait.delete(k));
      posterWait.set(k, p);
    }
    r = await p;
    if (r.status === 200 && r.body && r.body.length <= POSTER_MAX_BYTES) {
      posterCache.delete(k);
      posterCache.set(k, { at: Date.now(), status: 200, body: r.body, type: r.type });
      while (posterCache.size > POSTER_MAX) posterCache.delete(posterCache.keys().next().value);
    }
  }
  if (r.status !== 200) throw new Refuse(404, "No poster.");
  return r;
}

// open a library slot + start the stream at `offset` (s). -> {slot, replaced}
// plexreplace: x.replace = what's on the pad (replaceTarget) - its slot ends and this one opens in one step (mainstage.libraryOpen
// opts.replace: the feature and the "Coming up next" card carry straight over), THEN its encoder stops and its play / queue closes (retire),
// then the new title's encoder starts (media-control takes one stream per stage: the old one has to be off first). x.swap = a slot id to take
// over the same way without anything to retire (restart: a resume on a fresh slot after media-control forgot the stream).
// upnext2: x.brk = the station break in seconds - the slot opens and the marker is set now, the encoder starts when the break is over
// (fireBreak; the play's session is 'break' until then) -> + until
async function startOn(user, R, it, o, x = {}) {
  const left = Math.max(60, (it.duration || 0) - o.offset);
  const title = "📼 " + fmtTitle(it);
  const rep = x.replace || null, swapId = rep ? rep.slot_id : x.swap || null;
  const opened = await stage.libraryOpen(user, { room: R.id, title, minutes: Math.ceil(left / 60) + SLACK_MIN,
    ...(swapId ? { replace: swapId, reason: rep ? "library_replaced" : "library_restart", upnext: upNextInfo(it), actor: x.actor || null } : {}) });
  if (rep) await retire(user, R, rep, opened.slot.id);
  // upnext (owner 2026-11-05): the new slot is the pad's featured stage from now - a "Coming up next" card until its first frame (the
  // encoder probes the file and starts ffmpeg first: 1-6 s, more after a ⏹ of a title still shutting down). (plexreplace: a swap has its
  // marker from the open itself)
  if (!swapId) await stage.libraryUpNext(opened.slot.id, upNextInfo(it)).catch((e) => console.error("[medialib] up next:", e.message));
  if (x.brk > 0) {                                                       // upnext2: the station break - the encoder starts at `until`
    keys.set(R.id, opened.key);
    return { slot: opened.slot, replaced: opened.replaced || null, until: bnow() + x.brk * 1000 };
  }
  const body = { rtmp: stage.RTMP_PUBLIC, key: opened.key, ratingKey: String(it.key), offset: o.offset, quality: o.quality,
                 audio: o.audio, sub: o.sub, title: fmtTitle(it) };
  try {
    await must("PUT", `/streams/${encodeURIComponent(stageName(R.id))}`, body);
  } catch (e) {
    await stage.end(opened.slot.id, "library_failed", user.username).catch(() => {});
    throw e;
  }
  keys.set(R.id, opened.key);
  return { slot: opened.slot, replaced: opened.replaced || null };
}

// ── plexreplace: ▶ "Play this instead" (owner 2026-11-05) ──
// A pick while something from the library is on the pad replaces it in ONE request: play / playFor / the queue's start take
// {replace: true}; who may = whoever may start the new play (every rule of a fresh one: access, the pad, the daily cap, the price they
// confirmed, the pad's limit) AND control what's on (mayControl: its starter, the pad's owner / site staff, the library admins). Anyone
// else keeps the busy refusal (which now says what's on and whether a replace would be allowed - the sheet and Pepe offer it then).
// A 📼 QUEUE on the pad is replaced as a whole (it ends 'replaced by <who>', like ⏹ would end it): its titles are its starter's, billed per
// hour as they play - splicing someone's pick into it would bill them for a title they never chose; its starter has ⏭ / "+ Add to the
// queue" for "after this one". Everything that can refuse runs BEFORE anything stops; the old title keeps playing until the new slot exists.
/** What a replace on R would take off -> {slot_id, s, q, starter, by, title, left (queue titles after this one)} | {busy: true} (a queue
 *  that is starting) | null (nothing from the library is on) */
async function onNow(R) {
  const s = await session(R.id);
  const q = await require("./mediaqueue").activeFor(R.id);
  if (!s && !q) return null;
  if ((s && s.queue_id && !q) || (s && q && Number(s.queue_id) !== Number(q.id))) return { busy: true };
  const p = s ? (await getQuery("SELECT user_id, username FROM media_plays WHERE id = ?", [s.play_id]))[0] || {} : {};
  const cur = q ? q.items[q.pos] : null;
  return { slot_id: q ? q.slot_id : s.slot_id, s: s || null, q: q || null, starter: q ? q.user_id : p.user_id || null,
           by: q ? q.username : p.username || (s && s.by_user) || null, title: s ? s.title : cur ? fmtTitle(cur) : null,
           left: q ? Math.max(0, q.items.length - q.pos - 1) : 0 };
}
/** The replace's target, for a user who may control it -> the onNow() view | null (nothing on: an ordinary play). Throws control_denied.
 *  plexreplace review fix (race A / perms PROBE 1): `want` = the slot the person confirmed ("instead of <title>" - the sheet's on_pad.slot_id,
 *  Pepe's padState library.slot_id / a busy refusal's playing_slot). Something else on the pad now (another controller's replace landed
 *  first, it stopped and someone started theirs, a queue that was restarted on a fresh slot) -> 409 replace_changed with what's on NOW, so
 *  the sheet / Pepe ask again ("instead of <that>?") - a yes never takes off a title nobody agreed to replace. Nothing on any more: an
 *  ordinary play (nobody's title comes off). A queue that moved on to its next title keeps its slot - a replace aimed at it still goes.
 *  `want` true (a raw API call: "whatever is on") keeps the first build's meaning. */
async function replaceTarget(user, R, want = true) {
  const cur = await onNow(R);
  if (!cur || cur.busy) return null;                                  // (a starting queue: preflight says busy)
  if (!(await mayControl(user, R.id, cur.starter))) {
    const open = conf.on.library() || isLibAdmin(user);
    throw new Refuse(403, open ? CONTROL_DENIED : "Playing from Plex isn't open right now.", { code: open ? "control_denied" : "off", by: cur.by || null, playing: cur.title || null });
  }
  if (typeof want === "string" && want !== String(cur.slot_id)) {
    throw new Refuse(409, `What's on this pad's stage has just changed - it's "${cur.title || "something else"}" now. Confirm again to play yours instead of it.`,
                     { code: "replace_changed", can_replace: true, ...playingOf(cur, true, user) });
  }
  return cur;
}
// what's on (onNow), for a refusal / the sheet / Pepe: its title, a queue's titles after it, who started it (as the pad's 📼 player shows it)
// and whether that's you - the slot only for someone who may replace it (it's what a replace names)
const playingOf = (cur, can = true, user = null) => ({ playing: cur.title || null, playing_queue: !!cur.q, playing_left: cur.left || 0, playing_by: cur.by || null,
                                                      playing_mine: !!(user && user.userId && cur.starter && cur.starter === user.userId),
                                                      ...(can ? { playing_slot: cur.slot_id || null } : {}) });
/** {replace} of a request -> null (no replace) | true (whatever is on: the first build's raw form) | "<slot id>" (the slot the person confirmed) */
const SLOT_ARG = /^[A-Za-z0-9-]{8,64}$/;
function replaceWant(b) {
  const v = b ? b.replace : null;
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  if (typeof v === "string" && SLOT_ARG.test(v)) return v;
  return null;
}
const wantsReplace = (b) => !!replaceWant(b);
/** After the swap committed (the old slot ended 'library_replaced', the new one is open and featured): the old encoder off, its play closed
 *  (its held charge settled as it went - routed once it was on the stage), a queue ended - inside the pad's lock. Never throws. */
// upnext3 (1.99alm): toSlot = the slot that took over - whoever is lined up behind what was on waits behind it now (▶ Play this instead: they keep
// waiting behind the new title; a hand-over: the rest of the line behind the one that started). rep.why = a system hand-over (what was on ended
// by itself / was stopped / failed - nothing of it is stopped here); rep.end / rep.hold = a queue's (mediaqueue.retireForReplace)
async function retire(user, R, rep, toSlot = null) {
  try {
    if (rep.q) await require("./mediaqueue")._retire(rep.q, user, rep, toSlot);
    else {
      let pos = null;
      if (!(rep.s && rep.s.state === "break") && !rep.why) {            // (upnext2: one in its station break has no encoder yet; one that ended has none)
        try { const r = await must("POST", `/streams/${encodeURIComponent(stageName(R.id))}/stop`, {}); pos = r.stream && r.stream.position; }
        catch (e) { console.warn("[medialib] replace: media-control stop:", conf.errLine(e)); }
      }
      await dropSession(rep.s, rep.why || "replaced by " + user.username, pos != null ? pos : rep.s.position, rep.error || null);
      if (rep.s && rep.s.state === "break" && !rep.why) await markBrkStop(rep.s.play_id, user);   // (upnext2 review S3: its starter's own replace in its break)
    }
    if (toSlot) await require("./mediaqueue").moveAfter(R.id, rep.slot_id, toSlot);
  } catch (e) { console.error("[medialib] replace: closing what was on:", conf.errLine(e)); }
}

// mediactl's streams right now (null = can't be reached) + its cap
// 1.99acx: + `look`, numbered BEFORE the request - retryRestart tells a look taken before its second start answered (stale) from
// one taken after it
let looks = 0;
async function streamsNow() {
  const look = ++looks;
  try {
    const r = await call("GET", "/streams", null, { timeout: 6000 });
    if (r.status !== 200 || !r.json) return null;
    const list = r.json.streams || [];
    list.max = Number(r.json.max) || null;
    list.look = look;
    return list;
  } catch (e) { return null; }
}

/**
 * Play a title on a pad. b = {room, key, offset, quality, audio, sub, price (the price the user confirmed)}.
 * Internal: b._carry = {play} - a resume on a fresh slot, carrying the original play's charge (no new charge).
 */
async function play(user, b = {}, how = {}) {
  await init();
  const carry = b._carry || null;
  // a carried play (a resume on a fresh slot) was allowed when it started; anything else asks now
  const A = carry ? { ok: true, free: true, how: carry.access || "carried" } : await mustAccess(user);
  const R = await roomOf(b.room);
  if (!R) throw new Refuse(404, "No such pad.", { code: "pad" });
  // plexreplace: a replace runs under the pad's 📼 lock (mediaqueue's: the queue watcher and its controls wait for it)
  if (wantsReplace(b) && !carry && !how.locked) return require("./mediaqueue")._lock(R.id, () => play(user, b, { ...how, locked: true }));
  const rep = wantsReplace(b) && !carry ? await replaceTarget(user, R, replaceWant(b)) : null;
  const paidRules = !A.free || (!isLibAdmin(user) && !carry);
  await preflight(user, A, R, { carry: !!carry, replacing: rep });
  const it = await fetchItem(b.key);
  if (!it || !["movie", "episode"].includes(it.type) || !it.file) throw new Refuse(400, "Pick a movie or an episode.", { code: "bad" });
  const S = conf.get();
  const o = {
    offset: Math.max(0, Math.min(Math.floor(Number(b.offset) || 0), Math.max(0, (it.duration || 0) - 30))),
    quality: [1080, 720, 480].includes(Number(b.quality)) ? Number(b.quality) : S.library_quality,
    audio: b.audio !== undefined && b.audio !== null && b.audio !== "" && (it.audio || []).some((a) => a.index === Number(b.audio)) ? Number(b.audio) : null,
    sub: b.sub !== undefined && b.sub !== null && b.sub !== "" && (it.subs || []).some((s) => s.index === Number(b.sub) && s.burnable) ? Number(b.sub) : null,
  };
  // 1.99lw: the pad's 📼 limit (its owner's longest slot, else 6 h - mainstage.libraryMaxFor)
  if (!carry) {
    const lim = await stage.limitsFor(R.id);
    const left = Math.max(0, (it.duration || 0) - o.offset);
    if (left > lim.library_max * 60) throw new Refuse(400, `Slots on this pad run at most ${lim.library_max} minutes - start further in, or pick something shorter.`, { max_minutes: lim.library_max, code: "too_long" });
  }
  // the price: what the user saw and confirmed must be what we charge
  const q = carry || A.free ? { price: 0, hours: 0, per_hour: 0 } : priceFor(it.duration, o.offset, S);
  if (q.price > 0) {
    if (b.price == null || b.price === "") throw new Refuse(400, `This costs ${fmtPat(q.price)} PAT - confirm the price to play it.`, { price: q.price, code: "price" });
    if (Math.floor(Number(b.price)) !== q.price) throw new Refuse(409, `The price is ${fmtPat(q.price)} PAT now - confirm it again.`, { price: q.price, code: "price" });
  }
  // upnext2: the station break - not for a resume on a fresh slot (the same title carrying on: no "coming up next")
  const brk = carry ? 0 : await breakSec(R.id);
  // a free encoder before anyone pays (MEDIACTL_MAX_STREAMS); mediactl still has the last word (plexreplace: the one it replaces is free).
  // upnext2 review (safety F11, 1.99alc): a play that takes a station break asks too, a library admin's free one included - it holds its
  // encoder through the break (busyOf), and its start landing after someone's paid break took the encoder they were waiting for
  if (paidRules || q.price > 0 || brk > 0) await needEncoder(rep ? R.id : null);
  let order = null;
  if (q.price > 0) {
    order = await require("./shop").chargeService({ userId: user.userId, username: user.username, price: q.price, source: "medialib", hold: true,
      title: `📼 Play from Plex: ${fmtTitle(it)} on ${R.title || R.id}`,
      note: `${q.hours} h × ${fmtPat(q.per_hour)} PAT - held until it's on the stage, refunded if it never gets there` });
  }
  let slot, swapped = null, until = null;
  try {
    ({ slot, replaced: swapped, until = null } = await startOn(user, R, it, o, { replace: rep, swap: how.swap || null, actor: how.actor || null, brk }));
  } catch (e) {
    if (order) {
      const back = await require("./shop").refundService(order.order_id, "📼 it didn't start: " + String(e.message || "error").slice(0, 120), "system").catch(() => false);
      if (!back) console.error(`[medialib] order ${order.order_id}: start failed AND the refund didn't go through - check it by hand`);
      if (e && e.refuse) e.message += back ? " Your PAT was refunded." : "";
    }
    throw e;
  }
  const t = Date.now();
  const charge = carry ? (carry.charge === "held" ? "held" : "carried") : q.price > 0 ? "held" : "free";
  const p = await runQuery(`INSERT INTO media_plays (ts, user_id, username, room_id, slot_id, rating_key, title, kind, year, duration, quality, offset_start, audio, sub,
                              price, order_id, charge, carried_from, access)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                           [t, user.userId, user.username, R.id, slot.id, String(it.key), fmtTitle(it), it.type, it.year || null, it.duration || null,
                            o.quality, o.offset, o.audio, o.sub,
                            carry ? (carry.charge === "held" ? carry.price : 0) : q.price, carry ? carry.order_id : order ? order.order_id : null,
                            charge, carry ? carry.id : null, carry ? carry.access : A.how]);
  await runQuery(`INSERT INTO media_sessions (room_id, slot_id, play_id, rating_key, title, state, by_user, started, updated, position, duration, brk_until)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [R.id, slot.id, p.id, String(it.key), fmtTitle(it), until ? "break" : "playing", user.username, t, t, o.offset, it.duration || null, until]);
  if (until) armBreak(R.id, until);                                      // upnext2: its encoder starts then
  require("./plexpad").noteItem(it).catch(() => {});                   // 1.99nj: its metadata for the 📼 pad achievements
  if (rep) await logControl(user, R.id, "replace", `${rep.title || "?"} → ${fmtTitle(it)}`, { play_id: p.id, queue_id: rep.q ? rep.q.id : null });
  console.log(`[medialib] ${user.username} (${A.how}) plays "${fmtTitle(it)}" (${it.key}) on ${R.id} at ${o.offset}s, ${o.quality}p - play #${p.id}` +
              (q.price ? `, ${q.price} PAT held (order ${order.order_id})` : carry ? ` (carries play #${carry.id})` : ", free") +
              (rep ? ` - replaced "${rep.title}"${rep.q ? ` (queue #${rep.q.id})` : ""} on slot ${rep.slot_id}` : ""));
  return { ok: true, play_id: p.id, slot: { id: slot.id, stream: slot.stream, hls: slot.hls }, title: fmtTitle(it), price: q.price,
           order_id: order ? order.order_id : null, ...(until ? { starts_at: until, break_sec: brk } : {}),   // (upnext2: its station break)
           ...(rep ? { replaced: { title: rep.title || null, queue: !!rep.q, slot_id: rep.slot_id, feature: swapped ? swapped.carried || null : null } } : {}) };
}

/**
 * The pad rules for a new play / queue (shared with mediaqueue.js): one library stream per pad (a 📼 queue holds its pad
 * between titles too); a Plex user takes the pad under the ordinary stage-slot rules + the daily cap (a queue = one play).
 */
// upnext3 (1.99alm): system = a hand-over (the stage is this one's turn), booking = a booking's own start, resume = a paused queue carrying on (the
// same play - not counted on the cap again). A booking whose time came goes first: anything else (a fresh ▶, ▶ Play this instead, a queue's
// start) is refused booking_next - controllers replacing again and again would starve it.
async function preflight(user, A, R, { carry = false, replacing = null, behind = null, system = false, booking = false, resume = false } = {}) {
  // 1.99ajk plexchat: each refusal carries a stable code (plexchat.js words it in the room's language); the texts are unchanged.
  // A pad whose 📼 queue is on reads busy_queue (a queue's title has a session too): Pepe can offer "queue it next" for that one
  // plexreplace: `replacing` (replaceTarget) is what this play takes off - only THAT may be on; the busy refusal says what's on and whether
  // this user may replace it (can_replace: the sheet's "▶ Play this instead", Pepe's "play X instead?")
  const rep = replacing && !carry ? replacing : null;
  const qs = await safeQuery("SELECT id FROM media_queues WHERE room_id = ? AND state IN ('active','starting')", [R.id]);
  const queued = qs.length > 0;
  const otherQ = qs.filter((x) => !(rep && rep.q && Number(x.id) === Number(rep.q.id)));
  const s = await session(R.id);
  const busy = async (msg, code) => {
    const cur = await onNow(R).catch(() => null);
    const can = !!(cur && !cur.busy && user && user.userId && (await mayControl(user, R.id, cur.starter)));
    return new Refuse(409, msg, { code, can_replace: can, ...(cur && !cur.busy && cur.title ? playingOf(cur, can, user) : {}) });
  };
  // upnext2 (E): `behind` (an after-queue waiting behind the single play on that slot) - the play on now is what it waits for, not a refusal
  if (!behind && s && !(rep && s.slot_id === rep.slot_id)) throw await busy("This pad is already playing from the library - stop it first.", queued ? "busy_queue" : "busy_library");
  if (!behind && otherQ.length) {
    throw await busy("This pad is already playing a queue from the library - stop it first.", "busy_queue");
  }
  if (!behind && !system && !booking && !carry && (await require("./mediaqueue").bookingDue(R.id))) {
    throw new Refuse(409, "A stream booked for this time plays on this pad's stage next - pick yours after it.", { code: "booking_next" });
  }
  // upnext3 review (money 1, 1.99alm): nothing on, yet someone is lined up (a busy media-control held their start up, a restart between two) - they
  // go first: a fresh ▶ / a queue's start would jump the line (▶ Play this instead keeps them waiting behind it - only when something is on)
  if (!behind && !system && !booking && !carry && !resume && !rep && !s && !otherQ.length && (await require("./mediaqueue").lineWaits(R.id))) {
    throw new Refuse(409, "Someone lined up on this pad starts next - try again in a moment.", { code: "line_next" });
  }
  if (isLibAdmin(user) || carry) return;
  if (!(await stage.seesPad(user, R.id))) throw new Refuse(404, "No such pad.", { code: "pad" });
  if (await stage.isBanned(user.userId, R.id)) throw new Refuse(403, "You can't book the stage.", { code: "banned" });
  const mine = (await getQuery(`SELECT id FROM stage_slots WHERE userId = ? AND status IN ${OPEN_STATES}`, [user.userId]))
    .filter((x) => !(rep && x.id === rep.slot_id) && !(behind && x.id === behind));   // (plexreplace / upnext2 E: your own 📼 slot this one takes over from)
  if (mine.length) throw new Refuse(409, "You already have a stage slot - end it first.", { code: "has_slot" });
  const S0 = conf.get();
  const member = isMemberHow(A.how);
  const cap = member ? S0.library_free_daily_cap : S0.library_daily_cap;
  const used = resume ? 0 : member ? await freeToday(user.userId) : !A.free ? await paidToday(user.userId) : 0;
  if (!resume && (member || !A.free) && used >= cap) throw new Refuse(429, cap ? `That's ${cap} plays from Plex in the last 24 hours - the most for now.` : "Plays from Plex are paused right now.", { code: "cap", cap });
}
// streams in use: mediactl's playing ones + 1.99lr the 📼 queues between two titles (a queue holds its encoder)
async function busyOf(live, exceptRoom = null) {
  const names = new Set(live.filter((x) => x.state === "playing").map((x) => x.stage));
  const qs = await safeQuery(`SELECT q.room_id, s.state FROM media_queues q LEFT JOIN media_sessions s ON s.room_id = q.room_id
                              WHERE q.state IN ('active','starting')`, []);
  for (const q of qs) if (q.state !== "paused") names.add(stageName(q.room_id));
  // upnext2: a single play in its station break holds its encoder too (it starts when the break is over)
  for (const b of await safeQuery("SELECT room_id FROM media_sessions WHERE state = 'break'", [])) names.add(stageName(b.room_id));
  if (exceptRoom) names.delete(stageName(exceptRoom));               // plexreplace: the stream a replace stops first
  return names.size;
}
/** A free encoder (MEDIACTL_MAX_STREAMS) before anyone pays; mediactl still has the last word. exceptRoom: a replace on that pad (its stream
 *  comes off first, so it doesn't count). */
async function needEncoder(exceptRoom = null) {
  const live = await streamsNow();
  if (live === null) throw new Refuse(503, "The Plex player can't be reached right now - try again in a bit.", { code: "encoder_down" });
  const busy = await busyOf(live, exceptRoom);
  if (live.max && busy >= live.max) throw new Refuse(429, `Every library stream is in use (${busy} of ${live.max}) - try again when one ends.`, { code: "encoder_busy", busy, max: live.max });
  return live;
}

/**
 * 1.99lw: who may work the 📼 controls (pause / seek / next / stop / the queue): whoever started it, the library admins,
 * and the pad's owner (+ site staff - rooms.canManage). Pad mods have no site-side role (their powers are Camfrog's,
 * checked by Pepe), so they aren't in. Everyone else who sees the pad gets the read-only player.
 */
async function mayControl(user, roomId, starterId) {
  if (!user || !user.userId) return false;
  if (isLibAdmin(user)) return true;
  if (!conf.on.library()) return false;
  if (starterId && starterId === user.userId) return true;
  try { return !!(await rooms.canManage(user, roomId)); } catch (e) { return false; }
}
const CONTROL_DENIED = "Only whoever started it, the pad's owner or an admin can control it.";
/** One line in the control log (never throws). */
async function logControl(user, roomId, action, detail, { play_id = null, queue_id = null } = {}) {
  try {
    await runQuery("INSERT INTO media_controls (ts, room_id, user_id, username, action, detail, play_id, queue_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                   [Date.now(), String(roomId), user && user.userId || null, user && user.username || null, String(action).slice(0, 20),
                    detail == null ? null : String(detail).slice(0, 160), play_id, queue_id]);
  } catch (e) { /* the log never blocks a control */ }
}
const clock = (sec) => { sec = Math.max(0, Math.floor(Number(sec) || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
                         return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0"); };

async function needSession(user, room) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.", { code: "signin" });
  const R = await roomOf(room);
  if (!R) throw new Refuse(404, "No such pad.", { code: "pad" });
  const s = await session(R.id);
  if (!s) throw new Refuse(404, "Nothing from the library is playing on this pad.", { code: "nothing_on" });
  const p = (await getQuery("SELECT * FROM media_plays WHERE id = ?", [s.play_id]))[0] || {};
  if (!(await mayControl(user, R.id, p.user_id))) {
    const open = conf.on.library() || isLibAdmin(user);
    throw new Refuse(403, open ? CONTROL_DENIED : "Playing from Plex isn't open right now.", { code: open ? "control_denied" : "off" });
  }
  return { R, s, p };
}
/**
 * plexreplace review fix (perms F2 / race 2): the single-play controls (⏹, pause, resume, seek) run under the pad's 📼 lock - mediaqueue's,
 * which a replace, the queue's controls and the watcher hold too - and act only on the play they were authorised for (needSession). A play
 * that went while the control waited (a ▶ "Play this instead" swapped it, someone's ⏹, it ended): 409 play_changed / nothing_on and nothing
 * is touched - a ⏹ meant for the old title never stops the new one (media-control's stop / pause name the pad's stage, not the play).
 * fn(s) gets the session as it is now (the same play).
 */
function withPlay(R, s0, fn) {
  return require("./mediaqueue")._lock(R.id, async () => {
    const s = await session(R.id);
    if (!s) throw new Refuse(404, "Nothing from the library is playing on this pad.", { code: "nothing_on" });
    if (Number(s.play_id) !== Number(s0.play_id)) throw new Refuse(409, "What's playing on this pad has just changed - look again.", { code: "play_changed" });
    return fn(s);
  });
}

async function stop(user, room, reason = "stopped") {
  // 1.99lr: a 📼 queue (with or without a title on right now) ends as a whole
  const Q = require("./mediaqueue");
  const q = await Q.forRoomOf(room);
  if (q) return Q.stop(user, q, reason);
  const { R, s: s0 } = await needSession(user, room);
  return withPlay(R, s0, async (s) => {
    let pos = null;
    if (s.state !== "break") {                                           // (upnext2: ⏹ in its station break - nothing started yet, nothing will)
      try { const r = await must("POST", `/streams/${encodeURIComponent(stageName(R.id))}/stop`, {}); pos = r.stream && r.stream.position; }
      catch (e) { console.warn("[medialib] stop: media-control:", conf.errLine(e)); }
    }
    if (s.state === "break") await markBrkStop(s.play_id, user);         // (upnext2 review S3: its starter's own ⏹ in the break - the cap)
    // upnext3 (1.99alm, item 7 - owner 2026-11-07: "Start them instead."): whoever is lined up after it takes the stage over now (the swap: the
    // feature + the card carry, their station break first); the stopped play settles as ever (refunded if it never got on the stage)
    const h = await require("./mediaqueue").startAfter(s, "stopped", pos != null ? pos : s.position,
                                                        { why: reason + " by " + user.username, reason: "library_" + reason, actor: user.username });
    if (!h.retired) {
      await stage.end(s.slot_id, "library_" + reason, user.username).catch(() => {});
      await dropSession(s, reason + " by " + user.username, pos);
    }
    await logControl(user, R.id, "stop", s.title, { play_id: s.play_id });
    return { ok: true, ...(h.started ? { next_started: true } : {}) };
  });
}

async function pause(user, room) {
  const { R, s: s0 } = await needSession(user, room);
  return withPlay(R, s0, (s) => pause_(user, R, s));
}
async function pause_(user, R, s) {
  if (s.state !== "playing") throw new Refuse(409, "It isn't playing.", { code: "not_playing" });
  const r = await must("POST", `/streams/${encodeURIComponent(stageName(R.id))}/pause`, {});
  await runQuery("UPDATE media_sessions SET state = 'paused', position = ?, updated = ? WHERE room_id = ?", [r.stream ? r.stream.position : s.position, Date.now(), R.id]);
  await logControl(user, R.id, "pause", "at " + clock(r.stream ? r.stream.position : s.position), { play_id: s.play_id, queue_id: s.queue_id || null });
  return { ok: true, position: r.stream ? r.stream.position : null, resume_by: Date.now() + conf.get().library_pause_max_min * 60000 };
}

// resume (paused) or seek (any state): back on the same slot when it's still open, else on a fresh slot
async function restart(user, room, offset, how) {
  const { R, s: s0, p } = await needSession(user, room);
  return withPlay(R, s0, (s) => restart_(user, R, s, p, offset, how));      // (plexreplace review fix: under the pad's lock)
}
async function restart_(user, R, s, p, offset, how) {
  if (s.state === "break") {
    // upnext2: in its station break - a seek moves where it starts, a resume has nothing to do; the break goes on (fireBreak)
    const at = offset == null ? (s.position || 0) : Math.max(0, Math.min(Math.floor(Number(offset) || 0), Math.max(0, (s.duration || 0) - 30)));
    await logControl(user, R.id, offset == null ? "resume" : "seek", (offset == null ? "at " : clock(s.position) + " → ") + clock(at), { play_id: s.play_id });
    if (offset != null) await runQuery("UPDATE media_sessions SET position = ?, updated = ? WHERE room_id = ? AND play_id = ? AND state = 'break'", [at, Date.now(), R.id, s.play_id]);
    return { ok: true, position: at, same_slot: true, starts_at: Number(s.brk_until) || null };
  }
  await logControl(user, R.id, offset == null ? "resume" : "seek", offset == null ? "at " + clock(s.position) : clock(s.position) + " → " + clock(offset),
                   { play_id: s.play_id, queue_id: s.queue_id || null });
  const slot = await stage.getSlot(s.slot_id);
  const open = slot && !slot.settled && ["waiting", "active"].includes(slot.status);
  const name = encodeURIComponent(stageName(R.id));
  const pos = offset == null ? (s.position || 0) : Math.max(0, Math.min(Math.floor(Number(offset) || 0), Math.max(0, (s.duration || 0) - 30)));
  let swap = null;
  if (open) {
    try {
      const r = how === "resume" && offset == null ? await must("POST", `/streams/${name}/resume`, {}) : await must("POST", `/streams/${name}/seek`, { offset: pos });
      noteRestart(R.id, r.stream ? r.stream.offset : pos, s.play_id);     // 1.99acx: the watcher gives it one more go if it doesn't come back
      if (s.duration) await stage.libraryExtend(s.slot_id, Math.ceil(((slot.live_ms || 0) / 1000 + (s.duration - pos)) / 60) + SLACK_MIN);
      await runQuery("UPDATE media_sessions SET state = 'playing', position = ?, updated = ? WHERE room_id = ?", [r.stream ? r.stream.offset : pos, Date.now(), R.id]);
      return { ok: true, position: pos, same_slot: true };
    } catch (e) {
      if (!(e.status === 409 || e.status === 404)) throw e;     // mediactl forgot it (restarted): start it again below
      // 1.99lr: a 📼 queue keeps its slot: the same title starts again at `pos` with a fresh key
      if (s.queue_id) return { ...(await require("./mediaqueue").restartCurrent(s, pos, user.username, { locked: true })), same_slot: true };
      // plexreplace: the fresh slot TAKES OVER from this one (mainstage.libraryOpen opts.replace, reason 'library_restart'): its feature and
      // the card carry over - it used to end here first, and the pad sat with nothing featured until the new slot published
      swap = s.slot_id;
    }
  }
  if (s.queue_id) throw new Refuse(409, "This queue's slot has ended - start the queue again.");
  // a fresh slot (the old one ended - a long pause - or mediactl lost the stream). The new play carries the old one's
  // charge: a still-held one moves over (so it's routed / refunded by how the new one goes), a paid one stays paid.
  const carry = { id: p.id, charge: p.charge, price: p.price, order_id: p.order_id, access: p.access };
  if (p.charge === "held") await runQuery("UPDATE media_plays SET charge = 'moved' WHERE id = ? AND charge = 'held'", [p.id]);
  await dropSession(s, open ? "restarted" : "slot ended", pos);
  try { await call("POST", `/streams/${name}/stop`, {}); } catch (e) { /* best effort */ }
  // the new play stays the starter's (their controls, their log line), whoever pressed resume / seek
  const owner = p.user_id && p.user_id !== user.userId ? { userId: p.user_id, username: p.username, class: null } : user;
  try {
    const r = await play_(owner, { room: R.id, key: s.rating_key, offset: pos, quality: p.quality, audio: p.audio, sub: p.sub, _carry: carry },
                          swap ? { swap, actor: user.username } : {});
    // upnext2 review (safety F6, 1.99alc): the same title carries on on a fresh slot - titles someone added behind it wait behind THAT one now
    // (they were cancelled at the next watch: "something else started on the stage")
    if (r && r.slot && r.slot.id) await require("./mediaqueue").moveAfter(R.id, s.slot_id, r.slot.id);
    return { ...r, same_slot: false };
  } catch (e) {
    if (swap) await stage.end(swap, "library_restart", user.username).catch(() => {});   // (plexreplace: the swap didn't happen - it ends as before)
    // couldn't start again: a charge that was still held goes back to its first play and is settled there
    if (carry.charge === "held") {
      await runQuery("UPDATE media_plays SET charge = 'held' WHERE id = ? AND charge = 'moved'", [p.id]);
      await settle(p.id, !!(slot && slot.went_live), "restart failed").catch(() => {});
    }
    throw e;
  }
}
const play_ = (u, b, how) => play(u, b, how);
/**
 * 1.99ajk plexchat: the ONE entry point for a member's play (the /stage ▶ route, Pepe's chat - plexchat.js - and the Room Dock):
 * the pad's visibility (seesPad - an Approved pad they aren't inside reads as no such pad) first, then play() with every rule.
 * `b._carry` is internal (a resume on a fresh slot) and never taken from a request.
 */
async function playFor(user, b = {}) {
  const body = { ...(b || {}) };
  delete body._carry;
  const R = await roomOf(body.room);
  if (body.room && R && !(await stage.seesPad(user && user.userId ? user : null, R.id))) throw new Refuse(404, "No such pad.", { code: "pad" });
  return play(user, body);
}
/**
 * 1.99ajk plexchat: what a pad's stage looks like to `user` right now, for Pepe's chat answer (side-effect free: reads only).
 * -> null (no such pad) | {room, library: {title, queue, starter_is_you, by, per_hour, next, can_add, can_replace, left} | null, slot_taken,
 *    own_slot, daily_left, free, how}. Titles only - never a file.
 */
async function padState(user, room) {
  await init();
  const R = await roomOf(room);
  if (!R) return null;
  const s = await session(R.id);
  const q = await require("./mediaqueue").activeFor(R.id);
  const A = await access(user);
  let library = null;
  if (s || q) {
    const p = s ? (await getQuery("SELECT user_id, username FROM media_plays WHERE id = ?", [s.play_id]))[0] || {} : {};
    const starter = q ? q.user_id : p.user_id;
    const cur = q ? q.items[q.pos] : null;
    const nxt = q ? q.items[q.pos + 1] : null;
    library = { title: s ? s.title : cur ? fmtTitle(cur) : null, queue: !!q, starter_is_you: !!(user && user.userId && starter === user.userId),
                by: q ? q.username : p.username || (s && s.by_user) || null, per_hour: q ? Number(q.per_hour) || 0 : null,
                next: nxt ? fmtTitle(nxt) : null, state: s ? s.state : "waiting",
                // 1.99ajk plexchat review: may THIS speaker queue a title on it (mediaqueue.mayGrow - one rule)? Pepe says no up front
                can_add: q ? !!(await require("./mediaqueue").mayGrow(user, q)) : false,
                // plexreplace: may THIS speaker replace it ("play X instead?" - mayControl; a queue that is still starting: no) + the queue's
                // titles after this one (a replace ends them too)
                can_replace: !!(user && user.userId && !(s && s.queue_id && !q) && (await mayControl(user, R.id, starter))),
                left: q ? Math.max(0, q.items.length - q.pos - 1) : 0 };
    // 1.99amw plexqueue (owner 2026-11-08: "i should get the option of adding to the queue as well"): what /stage's "+" offers THIS speaker here
    // (lineInfo - the sheet's own rules), so Pepe can offer "queue it" beside "replace it": queue_as "append" (the END of a running queue they
    // may grow) | "after" (a queue of their own lined up after what's on) | null (queue_why: queue_off / line_full / queue_held / busy / off);
    // line = the pad's line as they stand in it; booking_due = a booked stream plays next (no replace then - /stage hides it too, preflight
    // would say booking_next); eta_sec = about when what they'd add starts; queue_as is there at all = this site takes play mode "queue"
    const MQ = require("./mediaqueue");
    const on = await onNow(R).catch(() => null);
    const li = on && !on.busy ? await lineInfo(user, R, on, A) : null;
    library.can_after = !!(li && li.can_after);
    library.queue_as = li && li.qOn ? (li.can_add ? "append" : li.can_after ? "after" : null) : null;
    library.queue_why = library.queue_as ? null : !li ? "busy" : !A.ok ? "off" : !li.qOn ? "queue_off" : li.held ? "queue_held" : li.line_full ? "line_full" : "busy";
    library.line = li ? { count: li.line.length, place: li.mineH ? li.line.indexOf(li.mineH) + 1 : null, mine: li.mineH ? li.mineH.count : 0, full: li.line_full,
                          max: MQ.AFTER_MAX, held: li.held } : null;
    library.booking_due = li && li.booking ? li.booking : null;
    if (li && li.booking) library.can_replace = false;
    library.eta_sec = null;
    // (1.99amw plexqueue review F6: a row of theirs already waiting - what they add goes on its end: after everyone ahead AND that row's titles)
    if (library.queue_as === "after") library.eta_sec = await MQ.lineEta(R.id, on, li.line, li.mineH ? li.line.indexOf(li.mineH) + 1 : Infinity).catch(() => null);
    else if (library.queue_as === "append") {
      const brk = await breakSec(R.id).catch(() => 0), rest = on.q.items.slice(on.q.pos + 1);
      library.eta_sec = Math.round((on.s && Number(on.s.queue_id) === Number(on.q.id) ? MQ.liveLeft(on.s) : Number((on.q.items[on.q.pos] || {}).duration) || 0)
                                   + MQ.totalSec(rest) + brk * (rest.length + 1));
    }
    // plexreplace review fix: the slot a replace names (Pepe sends it back with the yes - replace_changed if it isn't what's on by then)
    if (library.can_replace) library.slot_id = q ? q.slot_id : s.slot_id;
    // 1.99amw plexqueue review F8: ... and the slot a line-up goes behind ("queue it after <title>" - Pepe sends it back: behind_changed if it isn't
    // what's on by then); the end of their own queue names no title
    if (library.queue_as === "after" && on && on.slot_id) library.behind_slot = String(on.slot_id);
  }
  const open = await safeQuery(`SELECT id, source FROM stage_slots WHERE room_id = ? AND status IN ${OPEN_STATES}`, [R.id]);
  const RS = await rooms.stageSettings(R.id).catch(() => null);
  const slots = Math.max(1, Number(RS && RS.slot_count) || 1);
  const own = user && user.userId ? await safeQuery(`SELECT id FROM stage_slots WHERE userId = ? AND status IN ${OPEN_STATES}`, [user.userId]) : [];
  const S = conf.get();
  const member = isMemberHow(A.how);
  let daily_left = null;
  if (A.ok && member) daily_left = Math.max(0, S.library_free_daily_cap - (await freeToday(user.userId)));
  else if (A.ok && !A.free) daily_left = Math.max(0, S.library_daily_cap - (await paidToday(user.userId)));
  return { room: R.id, title: R.title || R.id, library, slot_taken: open.length >= slots, own_slot: own.length > 0, daily_left,
           free: !!A.free, how: A.how || null, ok: !!A.ok };
}
const resume = (user, room) => restart(user, room, null, "resume");
const seek = (user, room, offset) => restart(user, room, offset, "seek");

// ── state ──
async function state(user) {
  await init();
  if (!isLibAdmin(user)) throw new Refuse(403, "Admins only.");
  const S = conf.get(), K = conf.keys();
  const sessions = await getQuery("SELECT * FROM media_sessions ORDER BY started");
  const live = K.mediactl ? await streamsNow() : null;
  const byName = new Map((live || []).map((x) => [x.stage, x]));
  return {
    enabled: conf.on.library(), flag: !!S.library_enabled, configured: K.mediactl, pinned: K.mediactl_tls_pinned, reachable: live !== null,
    quality: S.library_quality, pause_max_min: S.library_pause_max_min, max_streams: live ? live.max : null,
    sessions: sessions.map((s) => {
      const m = byName.get(stageName(s.room_id));
      return { room: s.room_id, slot_id: s.slot_id, play_id: s.play_id, title: s.title, by: s.by_user, started: s.started,
               state: m ? m.state : s.state, position: m ? m.position : s.position, duration: (m && m.duration) || s.duration, error: m ? m.error : null,
               mode: m ? m.mode || null : null, queue_id: s.queue_id || null };
    }),
    plays: await getQuery("SELECT id, ts, username, room_id, title, kind, quality, offset_start, ended_at, end_reason, last_pos, error, price, charge, queue_id FROM media_plays ORDER BY id DESC LIMIT 30"),
    // 1.99lr: every running 📼 queue (what's left, the money) - the admins control them too
    queues: await require("./mediaqueue").views({ all: true }),
    queue_on: S.library_queue !== false,
  };
}
/**
 * What "+ Add to the queue" means for `user` on pad R while `cur` (onNow, not busy) is on - ONE rule source for /stage's sheet (mine's on_pad)
 * and, 1.99amw plexqueue, Pepe's padState:
 *   upnext2 (E): a running queue you may grow (its starter, a library admin on a free one - mayGrow): can_add; or titles behind a single title
 *   (a queue of yours that starts when it ends - mediaqueue.after: whoever may ▶ Play here; one already waiting: its owner grows it).
 *   upnext3 (1.99alm, item 5): "+ Line up my queue after this one" behind someone else's running queue too, and in turn behind others lined
 *   up - your own row grows; a full line (AFTER_MAX people) or a queue of yours paused for a booking: no (can_after).
 * -> {qOn, can_add, can_after, line_full, line_max, after (the sheet's), booking ({at, mine} - a booking whose time came: it plays next), held
 *    (a queue of yours paused for one), line (lineFor), mineH (your row of it)}
 */
async function lineInfo(user, R, cur, A) {
  const Qm = require("./mediaqueue"), qOn = conf.get().library_queue !== false && !!(A && A.ok);
  const out = { qOn, can_add: false, can_after: false, line_full: false, line_max: Qm.AFTER_MAX, after: null, booking: null, held: false, line: [], mineH: null };
  if (!user || !user.userId || !cur || cur.busy) return out;
  if (cur.q) out.can_add = !!(qOn && (await Qm.mayGrow(user, cur.q)));
  const line = await Qm.lineFor(R.id);
  const mineH = line.find((h) => h.row && h.row.user_id === user.userId) || null;
  const people = line.filter((h) => h.kind === "after").length;
  out.line = line;
  out.mineH = mineH;
  out.held = !!(mineH && mineH.kind === "resume");
  if (!out.can_add) out.can_after = !!(qOn && !out.held && ((mineH && mineH.kind === "after") || people < Qm.AFTER_MAX));
  if (!out.can_add && !mineH && qOn && people >= Qm.AFTER_MAX) out.line_full = true;
  // (ux 8: a paused queue of yours that was paid - its ✕ says what it paid for isn't refunded)
  if (line.length) out.after = { count: mineH ? mineH.count : line[0].count, mine: !!mineH, place: mineH ? line.indexOf(mineH) + 1 : null, line: line.length,
                                 ...(out.held ? { held: true, ...(Number(mineH.row.per_hour) > 0 && Number(mineH.row.paid_hours) > 0 ? { paid: true } : {}) } : {}) };
  const bk = line.find((h) => h.kind === "booking");
  if (bk) out.booking = { at: bk.at, mine: bk.user_id === user.userId };
  return out;
}
/** The Go-live page: may I play, on what terms, and what of mine is playing. */
async function mine(user, roomId) {
  await init();
  const A = await access(user);
  const S = conf.get();
  const member = isMemberHow(A.how);
  const out = { ok: true, access: A, notice: "Only show what we have the rights to show. Every play is logged.", member,
                price_per_hour: A.free ? 0 : Math.max(0, S.library_price), daily_cap: member ? S.library_free_daily_cap : S.library_daily_cap, daily_left: null,
                quality: S.library_quality, pause_max_min: S.library_pause_max_min, sessions: [], streams: null };
  if (!user || !user.userId) return out;
  if (A.ok && member) out.daily_left = Math.max(0, S.library_free_daily_cap - (await freeToday(user.userId)));
  else if (A.ok && !A.free) out.daily_left = Math.max(0, S.library_daily_cap - (await paidToday(user.userId)));
  const rows = await getQuery(`SELECT s.*, p.user_id, p.price, p.charge FROM media_sessions s JOIN media_plays p ON p.id = s.play_id
                               WHERE p.user_id = ? ORDER BY s.started`, [user.userId]);
  const live = A.ok || rows.length ? await streamsNow() : null;
  if (live) out.streams = { used: live.filter((x) => x.state === "playing").length, max: live.max };
  const byName = new Map((live || []).map((x) => [x.stage, x]));
  out.sessions = rows.map((s) => {
    const m = byName.get(stageName(s.room_id));
    return { room: s.room_id, slot_id: s.slot_id, play_id: s.play_id, title: s.title, started: s.started, price: s.price, charge: s.charge,
             state: m ? m.state : s.state, position: m ? m.position : s.position, duration: (m && m.duration) || s.duration, error: m ? m.error : null,
             queue_id: s.queue_id || null };
  });
  // 1.99lr: my 📼 queues (running, or ended in the last few minutes - "you're out of PAT" and the like)
  out.queue_on = S.library_queue !== false;
  out.queues = await require("./mediaqueue").views({ userId: user.userId, recent: true });
  if (roomId) {
    out.room = roomId;
    // plexreplace: what's on THIS pad (a pad the user sees) and whether a pick may replace it - the sheet's button reads "▶ Play this instead"
    try {
      const R = await roomOf(roomId);
      const cur = R && (await stage.seesPad(user, R.id)) ? await onNow(R) : null;
      if (cur && !cur.busy) {
        out.on_pad = { title: cur.title || null, queue: !!cur.q, left: cur.left, by: cur.by || null, mine: !!(cur.starter && cur.starter === user.userId),
                       can_replace: !!(A.ok && (await mayControl(user, R.id, cur.starter))) };
        // upnext2 (E) / upnext3 (1.99alm): "+ Add to the queue" / "+ Line up my queue" - lineInfo (1.99amw plexqueue: the same rules feed Pepe's
        // padState, so chat offers exactly what this sheet does)
        const li = await lineInfo(user, R, cur, A);
        if (cur.q) out.on_pad.can_add = li.can_add;
        if (!out.on_pad.can_add) out.on_pad.can_after = li.can_after;
        // (upnext3 review, ux 7: a full line says so - not only the permissions sentence)
        if (li.line_full) { out.on_pad.line_full = true; out.on_pad.line_max = li.line_max; }
        if (li.after) out.on_pad.after = li.after;
        // (item 10: a booking whose time came plays right after this title - ▶ Play this instead waits for it: booking_next)
        if (li.booking) { out.on_pad.booking = li.booking; out.on_pad.can_replace = false; }
        if (out.on_pad.can_replace) out.on_pad.slot_id = cur.slot_id;   // (plexreplace review fix: the sheet's replace names it)
      } else if (cur && cur.busy) out.on_pad = { title: null, queue: true, left: 0, by: null, mine: false, can_replace: false };
    } catch (e) { /* the sheet still works: the server refuses a busy pad with can_replace */ }
  }
  return out;
}

/**
 * 1.99lw: the 📼 player on a pad page (the DJ panel): what's on, where it is, the queue; the controls + the log for those
 * who may use them (mayControl), read-only for everyone else who sees the pad (signed in or not).
 */
async function player(user, room) {
  await init();
  const R = await roomOf(room);
  if (!R || !(await stage.seesPad(user && user.userId ? user : null, R.id))) throw new Refuse(404, "No such pad.");
  const s = await session(R.id);
  const Q = require("./mediaqueue");
  const q = await Q.activeFor(R.id);
  if (!s && !q) return { ok: true, on: false, room: R.id };
  const p = s ? (await getQuery("SELECT user_id, username FROM media_plays WHERE id = ?", [s.play_id]))[0] || {} : {};
  const starter = q ? q.user_id : p.user_id;
  const can = await mayControl(user, R.id, starter);
  const out = { ok: true, on: true, room: R.id, title: s ? s.title : null, state: s && s.state !== "break" ? s.state : "waiting", position: s ? s.position || 0 : 0,
                duration: s ? s.duration || null : null, at: Date.now(), by: q ? q.username : p.username || (s && s.by_user) || null,
                can_control: can, queue: null, log: [] };
  if (q) {
    const v = await Q.viewOf(q);
    out.queue = { id: v.id, pos: v.pos, count: v.count, now: v.now, next: v.next.slice(0, can ? 60 : 10), left_sec: v.left_sec };
    if (!s && v.now) out.title = fmtTitle(v.now);
    if (v.starts_at) out.starts_at = v.starts_at;                      // upnext2: in its station break
  }
  if (s && s.state === "break" && s.brk_until) out.starts_at = Number(s.brk_until);
  // upnext3 (1.99alm): who's lined up next, in order - a booking whose time came, a queue paused for it, then each person's own queue (behind a
  // single title or a running queue). Titles for everyone; who, and ✕ Take them out, only for whoever may take that row out (its owner, the
  // pad's owner, an admin - upnext2 review S13 / F4: `coming` never names who queued it). A booking is taken out on /stage, not here.
  const line = await Q.lineFor(R.id).catch(() => []);
  if (line.length) {
    out.line = [];
    for (const h of line) {
      const mine = !!(user && user.userId && h.user_id === user.userId);
      const sees = mine || (await mayControl(user, R.id, h.user_id));
      const canW = h.kind !== "booking" && sees;
      const from = h.kind === "resume" ? Math.max(0, Number(h.row.brk && h.row.brk.pos != null ? h.row.brk.pos : h.row.pos) || 0) : 0;
      const items = h.kind === "booking" ? (h.first ? [h.first] : []) : h.row.items.slice(from);
      // (review ux 8: a paused queue that was paid - its ✕ confirm says what it paid for isn't refunded; only to whoever may take it out)
      const paid = canW && h.kind === "resume" && Number(h.row.per_hour) > 0 && Number(h.row.paid_hours) > 0;
      out.line.push({ id: h.kind === "booking" ? null : h.row.id, kind: h.kind, count: h.count, next: items.slice(0, can || sees ? 60 : 10), mine, can_withdraw: canW,
                      ...(sees ? { by: h.username || null } : {}), ...(h.kind === "booking" ? { at: h.at } : {}), ...(paid ? { paid: true } : {}) });
    }
    // (an older page: `after` = your own row, else the first person's)
    const w = line.find((h) => h.kind === "after" && h.user_id === (user && user.userId)) || line.find((h) => h.kind === "after");
    if (w) {
      const x = out.line[line.indexOf(w)];
      out.after = { count: w.row.items.length, next: x.next, mine: x.mine, can_withdraw: x.can_withdraw, ...(x.by ? { by: x.by } : {}) };
    }
  }
  // upnext3 review (ux 13): whether this pad has a station break (the ⏹ confirm: what's lined up next starts "after its own break" - or right away)
  out.station_break = (await breakSec(R.id).catch(() => 0)) > 0;
  // upnext3 review (ux 1, privacy - upnext2 S13 / F4): who lined up after what's on, or was taken out, only for the pad's owner / staff / a library
  // admin (mayControl with no starter) - a plain starter of what's on keeps only their own line-up entries
  if (can) {
    const all = await mayControl(user, R.id, null);
    const rows = await getQuery("SELECT ts, user_id, username, action, detail FROM media_controls WHERE room_id = ? ORDER BY id DESC LIMIT 24", [R.id]);
    // (1.99amw plexqueue: "pepe_after" = a line-up asked for in chat - the same privacy as the website's own queue_after row)
    out.log = rows.filter((l) => all || !["queue_after", "queue_remove", "pepe_after"].includes(l.action) || (user && l.user_id === user.userId))
      .slice(0, 8).map((l) => ({ ts: l.ts, username: l.username, action: l.action, detail: l.detail }));
  }
  return out;
}

// ── 1.99acx: a seek / resume / next title that doesn't come back ──
// The 📼 "clicking the middle of the timeline just ends the stream" report (The Observance, 2026-10-18; confirmed on prod: nginx's
// "live: already publishing" in the same second as both seeks, media_plays 18 / 19 ended `error`): a race in mediactl 1.5.0 - a
// seek restarts the encoder on the SAME slot key, and the new ffmpeg was spawned while the one it replaced was still closing its
// RTMP publish, so nginx-rtmp refused the new one (not every time: it depends on how quickly the old one lets go), mediactl said
// `error`, and the watcher below ended the slot (a 📼 queue skipped the title). The real fix is in mediactl 1.6.0 (it waits for
// the old ffmpeg - deploy/mediactl/mediactl.js); this is the site's half, so an older mediactl - or any start
// that fails right after a control, whatever the reason - doesn't take the whole slot down: a stream in `error` within
// RESTART_GRACE_MS of a seek / resume / next / previous that never got past where that control put it is started ONCE more
// there (POST resume - an ffmpeg it collided with is gone by then) instead of ending the slot, and the watcher takes an extra
// look RECHECK_MS after the control and after that second start, so viewers wait seconds, not a whole tick.
// The price: a title that's really broken gets that one more start before it's ended / skipped - about RECHECK_MS more of an
// empty stage than before (the second failure is seen by the look after the second start; a WATCH_MS tick without timers).
const RESTART_GRACE_MS = 60 * 1000;
const RECHECK_MS = 5000;               // past mediactl's SIGKILL (4 s): the ffmpeg it replaced is surely gone
// room id -> {play_id, at, pos, tries, done_look}: the last control restart on that pad (memory only) - only THAT play gets the
// second go (a later title the queue started by itself, or a fresh play, doesn't inherit it)
const restarted = new Map();
let recheckOn = false;
function recheck(id) {
  if (!recheckOn) return;
  const h = setTimeout(() => watch(id).catch(() => {}), RECHECK_MS);
  if (h.unref) h.unref();
}
function noteRestart(roomId, pos, playId) {
  const id = String(roomId);
  restarted.set(id, { play_id: Number(playId) || 0, at: Date.now(), pos: Math.max(0, Math.floor(Number(pos) || 0)), tries: 0, done_look: null });
  recheck(id);
}
/** s = the media_sessions row, m = mediactl's view of its stream, look = the streamsNow look that view came from.
 *  -> true = handled here (don't end / skip it) */
async function retryRestart(s, m, look = 0) {
  const r = restarted.get(String(s.room_id));
  if (!r || r.play_id !== Number(s.play_id) || !m || m.state !== "error" || Date.now() - r.at > RESTART_GRACE_MS) return false;
  // started once more already: a look taken before that start answered (two watchers overlap - the tick and the quick look) still
  // shows the old failure - leave it; a look taken after it = it failed again: ended / skipped as before
  if (r.tries >= 1) return !(r.done_look != null && Number(look) > r.done_look);
  if (Number(m.offset) > r.pos + 5) return false;                     // it played on from there first: a real failure
  r.tries++;
  try {
    const x = await must("POST", `/streams/${encodeURIComponent(stageName(s.room_id))}/resume`, {});
    r.done_look = looks;
    await runQuery("UPDATE media_sessions SET state = 'playing', position = ?, updated = ? WHERE room_id = ? AND play_id = ?",
                   [x.stream ? x.stream.offset : r.pos, Date.now(), s.room_id, s.play_id]);
    console.warn(`[medialib] ${s.room_id}: "${s.title}" didn't come back after a seek / skip (${String(m.error || "error").slice(0, 200)}) - started it again at ${clock(r.pos)}`);
    recheck(String(s.room_id));
    return true;
  } catch (e) {
    r.done_look = looks;
    // 409: it isn't in `error` any more (a control started it again meanwhile, or mediactl forgot it) - the next look decides
    if (e && e.status === 409) return true;
    console.warn(`[medialib] ${s.room_id}: starting "${s.title}" again after a seek / skip failed: ${conf.errLine(e)}`);
    return false;
  }
}

// ── the watcher: keeps the slot and the stream together, and settles held charges ──
async function watch(only = null) {
  await init();
  // 1.99lr: queues between two titles (no session: waiting for an encoder) are retried here
  const Q = require("./mediaqueue");
  let n = only ? 0 : await Q.watchIdle().catch((e) => { console.error("[medialib] queues:", conf.errLine(e)); return 0; });
  const sessions = only ? await getQuery("SELECT * FROM media_sessions WHERE room_id = ?", [only]) : await getQuery("SELECT * FROM media_sessions");
  if (!sessions.length) return n;
  const live = await streamsNow();
  for (const s of sessions) {
    try {
      const slot = await stage.getSlot(s.slot_id);
      const name = stageName(s.room_id);
      const m = live ? live.find((x) => x.stage === name) : undefined;
      // 1.99lr: a 📼 queue's title - the queue moves on by itself (mediaqueue.js)
      if (s.queue_id) { if (await require("./mediaqueue").onWatch(s, slot, m, live)) n++; continue; }
      // plexreplace review fix (race 2): a single play is looked at under the pad's 📼 lock (mediaqueue's - a replace and the ⏹ / pause /
      // resume / seek controls hold it too), so nothing swaps the title between the re-check and the stop below
      if (await Q._lock(s.room_id, () => watchOne(s, live))) n++;
    } catch (e) {
      console.error("[medialib] watch:", conf.errLine(e));
    }
  }
  return n;
}
/** One look at a single play, inside the pad's lock: s0 = the session row this look was taken for, live = media-control's look. -> changed? */
async function watchOne(s0, live) {
  // plexreplace: only the session that is still the pad's - unchanged since this look - is acted on: a ▶ "Play this instead" swapped it (its
  // stop would cut the new title), a ⏹ ended it, a pause / resume / seek changed it while the look was on its way: the next look decides
  const s = await session(s0.room_id).catch(() => null);
  if (!s || Number(s.play_id) !== Number(s0.play_id) || Number(s.updated) !== Number(s0.updated)) return false;
  const slot = await stage.getSlot(s.slot_id);
  const name = stageName(s.room_id);
  const m = live ? live.find((x) => x.stage === name) : undefined;
  // on the stage: a held charge is routed now
  if (slot && slot.went_live) await settle(s.play_id, true).catch((e) => console.error("[medialib] settle:", conf.errLine(e)));
  if (!slot || slot.settled || slot.status === "ended") {
    // the stage ended it (Cut, time up, paused too long): stop the encoder (upnext2: none yet in a station break)
    if (s.state !== "break") { try { await call("POST", `/streams/${encodeURIComponent(name)}/stop`, {}); } catch (e) { /* unreachable: it'll fail to publish anyway */ } }
    await dropSession(s, "slot " + ((slot && slot.end_reason) || "ended"), m ? m.position : s.position);
    // upnext3 (1.99alm, item 7): a Cut of this slot / time up / idle - what's lined up behind it starts; a cleared stage (a cut of the whole pad,
    // a cut + ban, a ban) cancels it (mediaqueue.afterEnded)
    await require("./mediaqueue").afterEnded(s.room_id, slot || s.slot_id);
    return true;
  }
  // upnext2: in its station break - nothing to look at on media-control yet; one that is due starts now (its timer was lost: a restart)
  if (s.state === "break") return Number(s.brk_until) <= bnow() ? fireBreak(s.room_id, s.play_id) : false;
  if (live === null) return false;                                     // can't see the service right now: change nothing
  if (!m) {
    if (s.state === "paused" && Date.now() - s.updated < 60000) return false;
    // upnext3 (item 7): lost - whoever is lined up behind it takes the stage over (the swap); none / none could: it ends as ever
    const h = await require("./mediaqueue").startAfter(s, "lost", s.position, { why: "lost (media-control restarted?)", reason: "library_lost" });
    if (h.retired) return true;
    await stage.end(s.slot_id, "library_lost", "system").catch(() => {});
    await dropSession(s, "lost (media-control restarted?)", s.position);
    return true;
  }
  if (m.state === "error" && (await retryRestart(s, m, live.look))) return true;   // 1.99acx: right after a seek - once more
  // upnext2 (E): it ended (or failed) by itself and someone's titles wait behind it - they take the stage over now (the station break first)
  if (m.state === "ended" || m.state === "error") {
    const h = await require("./mediaqueue").startAfter(s, m.state === "ended" ? "finished" : "error", m.position, { error: m.state === "error" ? m.error || null : null });
    if (h.retired) return true;
  }
  if (m.state === "ended" || m.state === "error") {
    await stage.end(s.slot_id, m.state === "ended" ? "library_done" : "library_error", "system").catch(() => {});
    try { await call("POST", `/streams/${encodeURIComponent(name)}/stop`, {}); } catch (e) { /* best effort */ }
    await dropSession(s, m.state === "ended" ? "finished" : "error", m.position, m.error);
    return true;
  }
  await runQuery("UPDATE media_sessions SET position = ?, state = ?, updated = ? WHERE room_id = ? AND slot_id = ?",
                 [m.position, m.state === "paused" ? "paused" : "playing", Date.now(), s.room_id, s.slot_id]);
  return false;
}

// ── routes ──
let timer = null;
function register(app, { addUser, noTimers } = {}) {
  const guard = require("./middleware/authGuard");
  if (!noTimers && !timer) {
    timer = setInterval(() => watch().catch((e) => console.error("[medialib] watch:", conf.errLine(e))), WATCH_MS);
    timer.unref();
  }
  if (!noTimers) recheckOn = true;                                     // 1.99acx: the quick look after a seek / next title
  if (!noTimers) brkTimersOn = true;                                   // upnext2: a station break's title starts on time
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, ...(e.extra || {}) });
    console.error("[medialib]", conf.errLine(e));
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  // signed in + same-site POSTs; who may do what is decided per action (access(), needSession())
  const gate = (req, res, next) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    next();
  };
  const me = (req) => ({ userId: req.user.userId, username: req.user.username, class: req.user.class });
  const J = (fn) => [addUser, gate, async (req, res) => { try { res.set("Cache-Control", "no-store"); res.json(await fn(req)); } catch (e) { fail(res, e); } }];

  app.get("/api/medialib/state", ...J(async (req) => ({ ok: true, ...(await state(me(req))) })));
  app.get("/api/medialib/mine", ...J(async (req) => mine(me(req), req.query.room ? String(req.query.room) : null)));
  app.get("/api/medialib/search", ...J(async (req) => ({ ok: true, results: await search(me(req), req.query.q) })));
  app.get("/api/medialib/item/:key", ...J(async (req) => ({ ok: true, item: await item(me(req), req.params.key) })));
  app.get("/api/medialib/poster/:key", addUser, gate, async (req, res) => {
    try {
      const r = await poster(me(req), req.params.key);
      res.set("Content-Type", /^image\/(jpeg|png|webp)/.test(String(r.type)) ? String(r.type) : "image/jpeg");
      res.set("Cache-Control", "private, max-age=3600");
      res.send(r.body);
    } catch (e) { res.status(e.status === 403 ? 403 : 404).end(); }
  });
  // 1.99ajk plexchat: the pad check lives in playFor now (one rule source: this route, Pepe's chat and the Room Dock)
  app.post("/api/medialib/play", ...J(async (req) => playFor(me(req), req.body || {})));
  app.post("/api/medialib/stop", ...J(async (req) => stop(me(req), (req.body || {}).room)));
  app.post("/api/medialib/pause", ...J(async (req) => pause(me(req), (req.body || {}).room)));
  app.post("/api/medialib/resume", ...J(async (req) => resume(me(req), (req.body || {}).room)));
  app.post("/api/medialib/seek", ...J(async (req) => seek(me(req), (req.body || {}).room, (req.body || {}).offset)));
  // 1.99lw: the pad page's 📼 player (read-only without the rights; no sign-in needed to watch it)
  app.get("/api/medialib/player", addUser, async (req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json(await player(req.user && req.user.userId ? me(req) : null, String(req.query.room || ""))); }
    catch (e) { fail(res, e); }
  });
  // 1.99lr: 📼 queues - a season / a series / a list back to back in one slot (mediaqueue.js)
  require("./mediaqueue").routes(app, { J, me, timers: !noTimers });
}

module.exports = { init, register, play, playFor, padState, stop, pause, resume, seek, search, item, poster, state, mine, watch, settle, access, goLiveInfo, plexUser, priceFor, paidToday, freeToday,
                   // 1.99lr: for mediaqueue.js
                   player, mayControl, logControl,
                   _q: { must, call, fetchItem, mustAccess, isLibAdmin, isMemberHow, preflight, needEncoder, closePlay, session, roomOf, streamsNow, SLACK_MIN, fmtPat,
                         mayControl, logControl, clock, CONTROL_DENIED,
                         noteRestart, retryRestart, _restarted: restarted, _recheck: (on) => { recheckOn = !!on; }, _posters: posterCache,   // 1.99acx; upnext review: _posters
                         onNow, replaceTarget, retire, wantsReplace, replaceWant,                        // plexreplace
                         breakSec, armBreak, fireBreak, encoderHas, markBrkStop },                       // upnext2 (+ review fixes 1.99alc)
                   stageName, call, signHeaders, fmtTitle, upNextInfo, inviteItemLink, Refuse, _keys: keys,
                   breakSec, breakDue, armBreak, _brkTimers: (on) => { brkTimersOn = !!on; },      // upnext2: the station break
                   comingFor };                                                                    // upnext2 (D)
