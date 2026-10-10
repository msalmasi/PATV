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
//   media_plays      the log (+ price, order_id, charge: free | held | routed | refunded | moved | carried)
"use strict";
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { runQuery, getQuery } = require("./dbUtils");
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
  if (!base || secret.length < 32) throw new Refuse(503, "The media-control service isn't configured.");
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
      await runQuery("CREATE INDEX IF NOT EXISTS media_plays_user ON media_plays (user_id, ts)");
      await runQuery(`CREATE TABLE IF NOT EXISTS media_sessions (
        room_id TEXT PRIMARY KEY, slot_id TEXT NOT NULL, play_id INTEGER NOT NULL, rating_key TEXT, title TEXT, state TEXT NOT NULL,
        by_user TEXT, started INTEGER NOT NULL, updated INTEGER NOT NULL, position INTEGER, duration INTEGER)`);
      stage.setLibraryIdle(conf.get().library_pause_max_min);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const keys = new Map();   // room id -> the slot's raw RTMP key (memory only; resume after a mediactl restart needs it)
const fmtTitle = (it) => (it.type === "episode" && it.show
  ? `${it.show} S${String(it.season || 0).padStart(2, "0")}E${String(it.episode || 0).padStart(2, "0")} · ${it.title}`
  : `${it.title}${it.year ? ` (${it.year})` : ""}`).slice(0, 72);
const fmtPat = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");

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
    return { ok: true, free: true, how: user.class === "Admin" ? "admin" : "staff", until: null, why: null, message: null };
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
           quality: S.library_quality, pause_max_min: S.library_pause_max_min };
}
/** PAT for a play: library_price per STARTED hour of what's left of the title from `offset` (at least one hour). */
function priceFor(durationSec, offsetSec, S = conf.get()) {
  const per = Math.max(0, Math.floor(Number(S.library_price) || 0));
  if (!per) return { price: 0, hours: 0, per_hour: 0 };
  const left = Math.max(0, (Number(durationSec) || 0) - Math.max(0, Number(offsetSec) || 0));
  const hours = Math.max(1, Math.ceil(left / 3600));
  return { price: per * hours, hours, per_hour: per };
}
async function paidToday(userId, t = Date.now()) {
  const r = await safeQuery("SELECT COUNT(*) AS n FROM media_plays WHERE user_id = ? AND ts > ? AND charge IN ('held','routed')", [userId, t - DAY_MS]);
  return (r[0] && r[0].n) || 0;
}
// 1.99jp: a Plex member's free plays in the last 24 h (a resume on a fresh slot carries its play: not counted again)
async function freeToday(userId, t = Date.now()) {
  const r = await safeQuery("SELECT COUNT(*) AS n FROM media_plays WHERE user_id = ? AND ts > ? AND charge = 'free' AND access IN ('plex','override') AND carried_from IS NULL",
                            [userId, t - DAY_MS]);
  return (r[0] && r[0].n) || 0;
}
async function mustAccess(user) {
  const A = await access(user);
  if (!A.ok) throw new Refuse(A.why === "signin" ? 401 : 403, A.message, A.hint ? { hint: A.hint } : null);
  return A;
}
// the admins (library_allow) control every library stream; anyone else only the ones they started
const isLibAdmin = (user) => conf.libraryAllowed(user);

async function session(roomId) { return (await getQuery("SELECT * FROM media_sessions WHERE room_id = ?", [String(roomId)]))[0] || null; }
async function closePlay(playId, reason, pos, error) {
  await runQuery("UPDATE media_plays SET ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?), last_pos = COALESCE(?, last_pos), error = COALESCE(?, error) WHERE id = ?",
                 [Date.now(), reason, pos == null ? null : Math.round(pos), error || null, playId]);
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
  return (await rooms.bySlug(id)) || (await rooms.get(id)) || (id === rooms.HOUSE_ROOM ? { id, title: "Pepe's pad" } : null);
};

// ── actions ──
async function search(user, q) {
  await mustAccess(user);
  q = String(q || "").trim().slice(0, 100);
  if (q.length < 2) throw new Refuse(400, "Type at least 2 characters.");
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
async function poster(user, key) {
  await mustAccess(user);
  if (!/^\d{1,12}$/.test(String(key))) throw new Refuse(400, "Bad item.");
  const r = await call("GET", `/poster/${key}`, null, { raw: true });
  if (r.status !== 200) throw new Refuse(404, "No poster.");
  return r;
}

// open a library slot + start the stream at `offset` (s). -> {slot, play_id}
async function startOn(user, R, it, o) {
  const left = Math.max(60, (it.duration || 0) - o.offset);
  const title = "📼 " + fmtTitle(it);
  const opened = await stage.libraryOpen(user, { room: R.id, title, minutes: Math.ceil(left / 60) + SLACK_MIN });
  const body = { rtmp: stage.RTMP_PUBLIC, key: opened.key, ratingKey: String(it.key), offset: o.offset, quality: o.quality,
                 audio: o.audio, sub: o.sub, title: fmtTitle(it) };
  try {
    await must("PUT", `/streams/${encodeURIComponent(stageName(R.id))}`, body);
  } catch (e) {
    await stage.end(opened.slot.id, "library_failed", user.username).catch(() => {});
    throw e;
  }
  keys.set(R.id, opened.key);
  return opened.slot;
}

// mediactl's streams right now (null = can't be reached) + its cap
async function streamsNow() {
  try {
    const r = await call("GET", "/streams", null, { timeout: 6000 });
    if (r.status !== 200 || !r.json) return null;
    const list = r.json.streams || [];
    list.max = Number(r.json.max) || null;
    return list;
  } catch (e) { return null; }
}

/**
 * Play a title on a pad. b = {room, key, offset, quality, audio, sub, price (the price the user confirmed)}.
 * Internal: b._carry = {play} - a resume on a fresh slot, carrying the original play's charge (no new charge).
 */
async function play(user, b = {}) {
  await init();
  const carry = b._carry || null;
  // a carried play (a resume on a fresh slot) was allowed when it started; anything else asks now
  const A = carry ? { ok: true, free: true, how: carry.access || "carried" } : await mustAccess(user);
  const R = await roomOf(b.room);
  if (!R) throw new Refuse(404, "No such pad.");
  if (await session(R.id)) throw new Refuse(409, "This pad is already playing from the library - stop it first.");
  const paidRules = !A.free || (!isLibAdmin(user) && !carry);
  if (!isLibAdmin(user) && !carry) {
    // a Plex user takes the pad under the ordinary stage-slot rules
    if (!(await stage.seesPad(user, R.id))) throw new Refuse(404, "No such pad.");
    if (await stage.isBanned(user.userId, R.id)) throw new Refuse(403, "You can't book the stage.");
    const mine = await getQuery(`SELECT id FROM stage_slots WHERE userId = ? AND status IN ${OPEN_STATES}`, [user.userId]);
    if (mine.length) throw new Refuse(409, "You already have a stage slot - end it first.");
    const S0 = conf.get();
    const member = isMemberHow(A.how);
    const cap = member ? S0.library_free_daily_cap : S0.library_daily_cap;
    const used = member ? await freeToday(user.userId) : !A.free ? await paidToday(user.userId) : 0;
    if ((member || !A.free) && used >= cap) throw new Refuse(429, cap ? `That's ${cap} plays from Plex in the last 24 hours - the most for now.` : "Plays from Plex are paused right now.");
  }
  const it = await fetchItem(b.key);
  if (!it || !["movie", "episode"].includes(it.type) || !it.file) throw new Refuse(400, "Pick a movie or an episode.");
  const S = conf.get();
  const o = {
    offset: Math.max(0, Math.min(Math.floor(Number(b.offset) || 0), Math.max(0, (it.duration || 0) - 30))),
    quality: [1080, 720, 480].includes(Number(b.quality)) ? Number(b.quality) : S.library_quality,
    audio: b.audio !== undefined && b.audio !== null && b.audio !== "" && (it.audio || []).some((a) => a.index === Number(b.audio)) ? Number(b.audio) : null,
    sub: b.sub !== undefined && b.sub !== null && b.sub !== "" && (it.subs || []).some((s) => s.index === Number(b.sub) && s.burnable) ? Number(b.sub) : null,
  };
  // the price: what the user saw and confirmed must be what we charge
  const q = carry || A.free ? { price: 0, hours: 0, per_hour: 0 } : priceFor(it.duration, o.offset, S);
  if (q.price > 0) {
    if (b.price == null || b.price === "") throw new Refuse(400, `This costs ${fmtPat(q.price)} PAT - confirm the price to play it.`, { price: q.price });
    if (Math.floor(Number(b.price)) !== q.price) throw new Refuse(409, `The price is ${fmtPat(q.price)} PAT now - confirm it again.`, { price: q.price });
  }
  // a free encoder before anyone pays (MEDIACTL_MAX_STREAMS); mediactl still has the last word
  if (paidRules || q.price > 0) {
    const live = await streamsNow();
    if (live === null) throw new Refuse(503, "The Plex player can't be reached right now - try again in a bit.");
    const busy = live.filter((x) => x.state === "playing").length;
    if (live.max && busy >= live.max) throw new Refuse(429, `Every library stream is in use (${busy} of ${live.max}) - try again when one ends.`);
  }
  let order = null;
  if (q.price > 0) {
    order = await require("./shop").chargeService({ userId: user.userId, username: user.username, price: q.price, source: "medialib", hold: true,
      title: `📼 Play from Plex: ${fmtTitle(it)} on ${R.title || R.id}`,
      note: `${q.hours} h × ${fmtPat(q.per_hour)} PAT - held until it's on the stage, refunded if it never gets there` });
  }
  let slot;
  try {
    slot = await startOn(user, R, it, o);
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
  await runQuery(`INSERT INTO media_sessions (room_id, slot_id, play_id, rating_key, title, state, by_user, started, updated, position, duration)
                  VALUES (?, ?, ?, ?, ?, 'playing', ?, ?, ?, ?, ?)`,
                 [R.id, slot.id, p.id, String(it.key), fmtTitle(it), user.username, t, t, o.offset, it.duration || null]);
  console.log(`[medialib] ${user.username} (${A.how}) plays "${fmtTitle(it)}" (${it.key}) on ${R.id} at ${o.offset}s, ${o.quality}p - play #${p.id}` +
              (q.price ? `, ${q.price} PAT held (order ${order.order_id})` : carry ? ` (carries play #${carry.id})` : ", free"));
  return { ok: true, play_id: p.id, slot: { id: slot.id, stream: slot.stream, hls: slot.hls }, title: fmtTitle(it), price: q.price,
           order_id: order ? order.order_id : null };
}

async function needSession(user, room) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const R = await roomOf(room);
  if (!R) throw new Refuse(404, "No such pad.");
  const s = await session(R.id);
  if (!s) throw new Refuse(404, "Nothing from the library is playing on this pad.");
  const p = (await getQuery("SELECT * FROM media_plays WHERE id = ?", [s.play_id]))[0] || {};
  if (!isLibAdmin(user) && p.user_id !== user.userId) throw new Refuse(403, "Only whoever started it (or an admin) can control it.");
  if (!isLibAdmin(user) && !conf.on.library()) throw new Refuse(403, "Playing from Plex isn't open right now.");
  return { R, s, p };
}

async function stop(user, room, reason = "stopped") {
  const { R, s } = await needSession(user, room);
  let pos = null;
  try { const r = await must("POST", `/streams/${encodeURIComponent(stageName(R.id))}/stop`, {}); pos = r.stream && r.stream.position; }
  catch (e) { console.warn("[medialib] stop: media-control:", conf.errLine(e)); }
  await stage.end(s.slot_id, "library_" + reason, user.username).catch(() => {});
  await dropSession(s, reason + " by " + user.username, pos);
  return { ok: true };
}

async function pause(user, room) {
  const { R, s } = await needSession(user, room);
  if (s.state !== "playing") throw new Refuse(409, "It isn't playing.");
  const r = await must("POST", `/streams/${encodeURIComponent(stageName(R.id))}/pause`, {});
  await runQuery("UPDATE media_sessions SET state = 'paused', position = ?, updated = ? WHERE room_id = ?", [r.stream ? r.stream.position : s.position, Date.now(), R.id]);
  return { ok: true, position: r.stream ? r.stream.position : null, resume_by: Date.now() + conf.get().library_pause_max_min * 60000 };
}

// resume (paused) or seek (any state): back on the same slot when it's still open, else on a fresh slot
async function restart(user, room, offset, how) {
  const { R, s, p } = await needSession(user, room);
  const slot = await stage.getSlot(s.slot_id);
  const open = slot && !slot.settled && ["waiting", "active"].includes(slot.status);
  const name = encodeURIComponent(stageName(R.id));
  const pos = offset == null ? (s.position || 0) : Math.max(0, Math.min(Math.floor(Number(offset) || 0), Math.max(0, (s.duration || 0) - 30)));
  if (open) {
    try {
      const r = how === "resume" && offset == null ? await must("POST", `/streams/${name}/resume`, {}) : await must("POST", `/streams/${name}/seek`, { offset: pos });
      if (s.duration) await stage.libraryExtend(s.slot_id, Math.ceil(((slot.live_ms || 0) / 1000 + (s.duration - pos)) / 60) + SLACK_MIN);
      await runQuery("UPDATE media_sessions SET state = 'playing', position = ?, updated = ? WHERE room_id = ?", [r.stream ? r.stream.offset : pos, Date.now(), R.id]);
      return { ok: true, position: pos, same_slot: true };
    } catch (e) {
      if (!(e.status === 409 || e.status === 404)) throw e;     // mediactl forgot it (restarted): start it again below
      await stage.end(s.slot_id, "library_restart", user.username).catch(() => {});
    }
  }
  // a fresh slot (the old one ended - a long pause - or mediactl lost the stream). The new play carries the old one's
  // charge: a still-held one moves over (so it's routed / refunded by how the new one goes), a paid one stays paid.
  const carry = { id: p.id, charge: p.charge, price: p.price, order_id: p.order_id, access: p.access };
  if (p.charge === "held") await runQuery("UPDATE media_plays SET charge = 'moved' WHERE id = ? AND charge = 'held'", [p.id]);
  await dropSession(s, open ? "restarted" : "slot ended", pos);
  try { await call("POST", `/streams/${name}/stop`, {}); } catch (e) { /* best effort */ }
  // the new play stays the starter's (their controls, their log line), whoever pressed resume / seek
  const owner = p.user_id && p.user_id !== user.userId ? { userId: p.user_id, username: p.username, class: null } : user;
  try {
    return { ...(await play_(owner, { room: R.id, key: s.rating_key, offset: pos, quality: p.quality, audio: p.audio, sub: p.sub, _carry: carry })), same_slot: false };
  } catch (e) {
    // couldn't start again: a charge that was still held goes back to its first play and is settled there
    if (carry.charge === "held") {
      await runQuery("UPDATE media_plays SET charge = 'held' WHERE id = ? AND charge = 'moved'", [p.id]);
      await settle(p.id, !!(slot && slot.went_live), "restart failed").catch(() => {});
    }
    throw e;
  }
}
const play_ = (u, b) => play(u, b);
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
               mode: m ? m.mode || null : null };
    }),
    plays: await getQuery("SELECT id, ts, username, room_id, title, kind, quality, offset_start, ended_at, end_reason, last_pos, error, price, charge FROM media_plays ORDER BY id DESC LIMIT 30"),
  };
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
             state: m ? m.state : s.state, position: m ? m.position : s.position, duration: (m && m.duration) || s.duration, error: m ? m.error : null };
  });
  if (roomId) out.room = roomId;
  return out;
}

// ── the watcher: keeps the slot and the stream together, and settles held charges ──
async function watch() {
  await init();
  const sessions = await getQuery("SELECT * FROM media_sessions");
  if (!sessions.length) return 0;
  const live = await streamsNow();
  let n = 0;
  for (const s of sessions) {
    try {
      const slot = await stage.getSlot(s.slot_id);
      const name = stageName(s.room_id);
      const m = live ? live.find((x) => x.stage === name) : undefined;
      // on the stage: a held charge is routed now
      if (slot && slot.went_live) await settle(s.play_id, true).catch((e) => console.error("[medialib] settle:", conf.errLine(e)));
      if (!slot || slot.settled || slot.status === "ended") {
        // the stage ended it (Cut, time up, paused too long): stop the encoder
        try { await call("POST", `/streams/${encodeURIComponent(name)}/stop`, {}); } catch (e) { /* unreachable: it'll fail to publish anyway */ }
        await dropSession(s, "slot " + ((slot && slot.end_reason) || "ended"), m ? m.position : s.position);
        n++; continue;
      }
      if (live === null) continue;                                    // can't see the service right now: change nothing
      if (!m) {
        if (s.state === "paused" && Date.now() - s.updated < 60000) continue;
        await stage.end(s.slot_id, "library_lost", "system").catch(() => {});
        await dropSession(s, "lost (media-control restarted?)", s.position);
        n++; continue;
      }
      if (m.state === "ended" || m.state === "error") {
        await stage.end(s.slot_id, m.state === "ended" ? "library_done" : "library_error", "system").catch(() => {});
        try { await call("POST", `/streams/${encodeURIComponent(name)}/stop`, {}); } catch (e) { /* best effort */ }
        await dropSession(s, m.state === "ended" ? "finished" : "error", m.position, m.error);
        n++; continue;
      }
      await runQuery("UPDATE media_sessions SET position = ?, state = ?, updated = ? WHERE room_id = ? AND slot_id = ?",
                     [m.position, m.state === "paused" ? "paused" : "playing", Date.now(), s.room_id, s.slot_id]);
    } catch (e) {
      console.error("[medialib] watch:", conf.errLine(e));
    }
  }
  return n;
}

// ── routes ──
let timer = null;
function register(app, { addUser, noTimers } = {}) {
  const guard = require("./middleware/authGuard");
  if (!noTimers && !timer) {
    timer = setInterval(() => watch().catch((e) => console.error("[medialib] watch:", conf.errLine(e))), WATCH_MS);
    timer.unref();
  }
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
  app.post("/api/medialib/play", ...J(async (req) => {
    const b = { ...(req.body || {}) };
    delete b._carry;                                                   // internal only
    const R = await roomOf(b.room);
    if (b.room && R && !(await stage.seesPad(req.user, R.id))) throw new Refuse(404, "No such pad.");
    return play(me(req), b);
  }));
  app.post("/api/medialib/stop", ...J(async (req) => stop(me(req), (req.body || {}).room)));
  app.post("/api/medialib/pause", ...J(async (req) => pause(me(req), (req.body || {}).room)));
  app.post("/api/medialib/resume", ...J(async (req) => resume(me(req), (req.body || {}).room)));
  app.post("/api/medialib/seek", ...J(async (req) => seek(me(req), (req.body || {}).room, (req.body || {}).offset)));
}

module.exports = { init, register, play, stop, pause, resume, seek, search, item, state, mine, watch, settle, access, goLiveInfo, plexUser, priceFor, paidToday, freeToday,
                   stageName, call, signHeaders, fmtTitle, inviteItemLink, Refuse, _keys: keys };
