// mediarequests.js — 1.99ji: 🎬 Request a movie / show (Overseerr - also Seerr / Jellyseerr, the same v1 API).
//
// /requests: search through Overseerr (availability shown), request it as your PATV account, see your requests'
// status (pending / approved / partly available / available / declined), and get a 🔔 notice when it's on Plex.
//
// Who Overseerr sees as the requester:
//   1. an admin's explicit link (media_user_links: PATV account -> Overseerr user id)
//   2. else the Overseerr user with the same VERIFIED email as the PATV account
//   3. else the service user (setting overseerr_service_user; "" = the API key's owner); our own row keeps the PATV name
// The request is made on that user's behalf ({userId} in the request body - the API key is an admin's), so their
// own Overseerr quota and auto-approve rules apply.
//
// Paying (mediaconf): a request credit if the account has one (bought in the store: "10 Additional Movie Requests"
// etc. - the shop hook below adds them), else request_price_movie / _tv PAT through shop.chargeService (an official
// order on their orders page), else free. Overseerr refusing / erroring at once = the credit or PAT goes straight
// back; a request that's later DECLINED, FAILED or deleted before it became available is refunded once (poll / webhook).
//
// Status comes from Overseerr's API only: polled every request_poll_min minutes, and at once when Overseerr's webhook
// (POST /api/requests/overseerr-webhook, header Authorization = OVERSEERR_WEBHOOK_SECRET) says something changed -
// the webhook body is only a hint, never trusted for the status itself.
//
//   media_requests     one row per PATV request
//   media_credits      request credits per account and kind (movie | tv)
//   media_user_links   admin links PATV account -> Overseerr user
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const conf = require("./mediaconf");

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}
const env = (k) => String(process.env[k] || "").trim();
let clock = () => Date.now();
const DAY = 86400000;

// Overseerr's numbers
const REQ = { 1: "pending", 2: "approved", 3: "declined", 4: "failed", 5: "completed" };
const MEDIA = { 1: "unknown", 2: "pending", 3: "processing", 4: "partial", 5: "available", 6: "blocked", 7: "deleted" };
const OPEN = ["submitting", "pending", "approved", "partial"];
const LABEL = {
  submitting: "Sending…", pending: "Waiting for approval", approved: "Approved — on its way", partial: "Partly available",
  available: "Available on Plex", declined: "Declined (refunded)", failed: "Failed (refunded)", removed: "Removed (refunded)", error: "Didn't go through",
};

// ── the Overseerr client ──
async function api(method, p, body = null, { timeout = 15000 } = {}) {
  const base = env("OVERSEERR_URL").replace(/\/+$/, ""), key = env("OVERSEERR_API_KEY");
  if (!base || !key) throw new Refuse(503, "Requests aren't configured.");
  let r;
  try {
    r = await fetch(base + "/api/v1" + p, {
      method, headers: { "X-Api-Key": key, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout), redirect: "error",
    });
  } catch (e) {
    throw Object.assign(new Refuse(502, "The request server can't be reached right now."), { upstream: true });
  }
  let json = null;
  try { json = await r.json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json };
}

// ── storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await conf.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS media_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT, media_type TEXT NOT NULL, tmdb_id INTEGER NOT NULL,
        title TEXT, year INTEGER, poster TEXT, seasons TEXT, status TEXT NOT NULL, media_status INTEGER, overseerr_id INTEGER,
        overseerr_user INTEGER, mapped_by TEXT, paid_with TEXT, price INTEGER NOT NULL DEFAULT 0, order_id INTEGER,
        refunded_at INTEGER, notified_at INTEGER, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, checked INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS media_requests_user ON media_requests (user_id, id)");
      await runQuery("CREATE INDEX IF NOT EXISTS media_requests_status ON media_requests (status, checked)");
      await runQuery("CREATE INDEX IF NOT EXISTS media_requests_tmdb ON media_requests (media_type, tmdb_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS media_credits (
        user_id TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, kind))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS media_user_links (
        user_id TEXT PRIMARY KEY, overseerr_user INTEGER NOT NULL, set_by TEXT, at INTEGER)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── credits ──
async function credits(userId) {
  await init();
  const out = { movie: 0, tv: 0 };
  for (const r of await getQuery("SELECT kind, n FROM media_credits WHERE user_id = ?", [userId])) out[r.kind] = r.n;
  return out;
}
async function addCredits(userId, kind, n) {
  await init();
  await runQuery(`INSERT INTO media_credits (user_id, kind, n) VALUES (?, ?, ?)
                  ON CONFLICT(user_id, kind) DO UPDATE SET n = n + excluded.n`, [userId, kind, n]);
}
async function takeCredit(userId, kind) {
  const r = await runQuery("UPDATE media_credits SET n = n - 1 WHERE user_id = ? AND kind = ? AND n > 0", [userId, kind]);
  return !!(r && r.changes);
}

// ── who requests ──
let usersCache = { at: 0, list: null };
async function overseerrUsers() {
  if (usersCache.list && clock() - usersCache.at < 10 * 60000) return usersCache.list;
  const r = await api("GET", "/user?take=1000&skip=0&sort=created");
  if (r.status !== 200 || !r.json) throw new Refuse(502, "Couldn't read the request server's users.");
  usersCache = { at: clock(), list: (r.json.results || []).map((u) => ({ id: u.id, email: String(u.email || "").toLowerCase(), name: u.displayName || u.username || u.plexUsername || ("#" + u.id) })) };
  return usersCache.list;
}
/** -> {id: Overseerr user id | null (= the API key's owner), how: link|email|service|owner} */
async function requesterFor(userId) {
  await init();
  const link = (await getQuery("SELECT overseerr_user FROM media_user_links WHERE user_id = ?", [userId]))[0];
  if (link) return { id: link.overseerr_user, how: "link" };
  const u = (await getQuery("SELECT email, isEmailVerified FROM users WHERE userId = ?", [userId]).catch(() => []))[0];
  if (u && u.email && Number(u.isEmailVerified) === 1) {
    try {
      const m = (await overseerrUsers()).find((x) => x.email && x.email === String(u.email).toLowerCase());
      if (m) return { id: m.id, how: "email" };
    } catch (e) { /* fall through to the service user */ }
  }
  const svc = conf.get().overseerr_service_user;
  return svc ? { id: Number(svc), how: "service" } : { id: null, how: "owner" };
}

// ── search ──
const year = (d) => (d && /^\d{4}/.test(d) ? Number(String(d).slice(0, 4)) : null);
const poster = (p) => (p && /^\/[A-Za-z0-9._-]+$/.test(p) ? p : null);
function shape(x) {
  const ms = x.mediaInfo ? x.mediaInfo.status : null;
  return { type: x.mediaType, tmdb: x.id, title: x.title || x.name || "?", year: year(x.releaseDate || x.firstAirDate), poster: poster(x.posterPath),
           overview: String(x.overview || "").slice(0, 300), media_status: ms || 1, availability: MEDIA[ms || 1] || "unknown" };
}
async function search(user, q, page = 1) {
  await init();
  if (!conf.on.requests()) throw new Refuse(403, "Requests are switched off right now.");
  q = String(q || "").trim().slice(0, 100);
  if (q.length < 2) throw new Refuse(400, "Type at least 2 characters.");
  // Overseerr wants reserved characters double-encoded in `query`
  const r = await api("GET", `/search?query=${encodeURIComponent(q).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}&page=${Math.max(1, Math.min(10, Number(page) || 1))}&language=en`);
  if (r.status !== 200 || !r.json) throw new Refuse(502, "The request server didn't answer the search.");
  return (r.json.results || []).filter((x) => x.mediaType === "movie" || x.mediaType === "tv").slice(0, 20).map(shape);
}
async function details(type, tmdb) {
  if (!["movie", "tv"].includes(type) || !/^\d{1,9}$/.test(String(tmdb))) throw new Refuse(400, "Bad title.");
  const r = await api("GET", `/${type}/${tmdb}?language=en`);
  if (r.status === 404) throw new Refuse(404, "That title isn't known.");
  if (r.status !== 200 || !r.json) throw new Refuse(502, "The request server didn't answer.");
  const x = r.json;
  const mi = x.mediaInfo || {};
  const seasonState = new Map((mi.seasons || []).map((s) => [s.seasonNumber, s.status]));
  return {
    type, tmdb: Number(tmdb), title: x.title || x.name || "?", year: year(x.releaseDate || x.firstAirDate), poster: poster(x.posterPath),
    media_status: mi.status || 1, availability: MEDIA[mi.status || 1] || "unknown",
    seasons: type === "tv" ? (x.seasons || []).filter((s) => s.seasonNumber > 0).map((s) => ({
      n: s.seasonNumber, episodes: s.episodeCount || 0, status: seasonState.get(s.seasonNumber) || 1,
      availability: MEDIA[seasonState.get(s.seasonNumber) || 1] || "unknown" })) : undefined,
  };
}

// ── request ──
async function request(user, b = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!conf.on.requests()) throw new Refuse(403, "Requests are switched off right now.");
  const S = conf.get();
  const type = b.type === "tv" ? "tv" : b.type === "movie" ? "movie" : null;
  if (!type) throw new Refuse(400, "Pick a movie or a show.");
  const me = (await getQuery("SELECT userId, username, level FROM users WHERE userId = ?", [user.userId]))[0];
  if (!me) throw new Refuse(401, "Sign in first.");
  if ((me.level || 0) < S.request_min_level) throw new Refuse(403, `Requests open at level ${S.request_min_level}.`);
  const t = clock();
  const today = (await getQuery("SELECT COUNT(*) AS n FROM media_requests WHERE user_id = ? AND created > ? AND status NOT IN ('error')", [me.userId, t - DAY]))[0].n;
  if (S.requests_per_day > 0 && today >= S.requests_per_day) throw new Refuse(429, `That's ${today} requests in the last 24 hours — the most for now.`);
  const d = await details(type, b.tmdb);
  if (d.media_status === 5) throw new Refuse(409, `${d.title} is already on Plex.`);
  let seasons = null;
  if (type === "tv") {
    const want = b.seasons === "all" || b.seasons == null || b.seasons === ""
      ? d.seasons.filter((s) => s.status < 4).map((s) => s.n)
      : [].concat(b.seasons).map(Number).filter((n) => d.seasons.some((s) => s.n === n && s.status < 4));
    seasons = [...new Set(want)].sort((a, c) => a - c);
    if (!seasons.length) throw new Refuse(409, "Every season you picked is already available or on its way.");
  } else if (d.media_status === 2 || d.media_status === 3) {
    throw new Refuse(409, `${d.title} has already been requested — it's on its way.`);
  }
  const dup = (await getQuery(`SELECT id FROM media_requests WHERE user_id = ? AND media_type = ? AND tmdb_id = ? AND status IN (${OPEN.map(() => "?").join(",")})`,
                              [me.userId, type, d.tmdb, ...OPEN]))[0];
  if (dup) throw new Refuse(409, "You've already asked for that one.");

  // pay: a credit, else PAT, else free
  const price = type === "tv" ? S.request_price_tv : S.request_price_movie;
  const label = `🎬 Request: ${d.title}${d.year ? ` (${d.year})` : ""}${seasons ? ` — season${seasons.length > 1 ? "s" : ""} ${seasons.join(", ")}` : ""}`;
  let paid = { with: "free", price: 0, order_id: null };
  if (await takeCredit(me.userId, type)) paid = { with: "credit", price: 0, order_id: null };
  else if (price > 0) {
    const o = await require("./shop").chargeService({ userId: me.userId, username: me.username, title: label, price, source: "website",
                                                      note: "Media request — refunded automatically if it's declined or fails" });
    paid = { with: "pat", price, order_id: o.order_id };
  }
  const row = await runQuery(`INSERT INTO media_requests (user_id, username, media_type, tmdb_id, title, year, poster, seasons, status, paid_with, price, order_id, created, updated)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?, ?, ?, ?, ?)`,
                             [me.userId, me.username, type, d.tmdb, d.title, d.year, d.poster, seasons ? JSON.stringify(seasons) : null, paid.with, paid.price, paid.order_id, t, t]);
  const id = row.id;
  let who = { id: null, how: "owner" };
  try {
    who = await requesterFor(me.userId);
    const body = { mediaType: type, mediaId: d.tmdb, ...(seasons ? { seasons } : {}), ...(who.id ? { userId: who.id } : {}) };
    const r = await api("POST", "/request", body);
    if (r.status !== 201 && r.status !== 200) {
      const msg = (r.json && (r.json.message || r.json.error)) || `answered ${r.status}`;
      throw Object.assign(new Refuse(r.status === 403 || r.status === 409 ? 409 : 502,
        r.status === 403 ? `The request server refused it (${String(msg).slice(0, 120)}). Nothing was charged.`
        : r.status === 409 ? "That's already been requested. Nothing was charged." : "The request server couldn't take it right now. Nothing was charged."), { upstream: true });
    }
    const q = r.json || {};
    const st = statusOf(q.status, q.media && q.media.status);
    await runQuery("UPDATE media_requests SET status = ?, media_status = ?, overseerr_id = ?, overseerr_user = ?, mapped_by = ?, updated = ?, checked = ? WHERE id = ?",
                   [st, (q.media && q.media.status) || null, q.id || null, who.id, who.how, clock(), clock(), id]);
    console.log(`[requests] ${me.username} requested ${type} ${d.tmdb} "${d.title}" -> Overseerr #${q.id} as ${who.how}${who.id ? " " + who.id : ""} (${paid.with}${paid.price ? " " + paid.price : ""})`);
    if (["declined", "failed"].includes(st)) await refund(id, `Overseerr ${st} it`);
    return { ok: true, id, status: st, label: LABEL[st], paid_with: paid.with, price: paid.price };
  } catch (e) {
    await runQuery("UPDATE media_requests SET status = 'error', error = ?, overseerr_user = ?, mapped_by = ?, updated = ? WHERE id = ?",
                   [conf.errLine(e), who.id, who.how, clock(), id]);
    await refund(id, "didn't go through");
    if (e.refuse) throw e;
    console.error("[requests] request:", conf.errLine(e));
    throw new Refuse(502, "The request didn't go through. Nothing was charged.");
  }
}
function statusOf(reqStatus, mediaStatus) {
  if (mediaStatus === 5 || reqStatus === 5) return "available";
  if (reqStatus === 3) return "declined";
  if (reqStatus === 4) return "failed";
  if (mediaStatus === 4) return "partial";
  if (reqStatus === 2) return "approved";
  return "pending";
}

// Give the credit / PAT back, once. Status is set by the caller.
async function refund(id, reason) {
  const r = await runQuery("UPDATE media_requests SET refunded_at = ? WHERE id = ? AND refunded_at IS NULL", [clock(), id]);
  if (!r || !r.changes) return false;
  const row = (await getQuery("SELECT * FROM media_requests WHERE id = ?", [id]))[0];
  try {
    if (row.paid_with === "credit") await addCredits(row.user_id, row.media_type, 1);
    else if (row.paid_with === "pat" && row.order_id) await require("./shop").refundService(row.order_id, `Media request ${reason}`, "system");
  } catch (e) {
    console.error(`[requests] refund of request #${id} failed - check order #${row.order_id}:`, conf.errLine(e));
    await runQuery("UPDATE media_requests SET refunded_at = NULL WHERE id = ?", [id]);
    return false;
  }
  return true;
}

// ── status sync (poll + webhook) ──
async function sync(row) {
  if (!row.overseerr_id) return row.status;
  const r = await api("GET", `/request/${row.overseerr_id}`);
  let st;
  let ms = row.media_status;
  if (r.status === 404) st = row.status === "available" ? "available" : "removed";
  else if (r.status !== 200 || !r.json) return row.status;
  else { ms = r.json.media ? r.json.media.status : ms; st = statusOf(r.json.status, ms); }
  await runQuery("UPDATE media_requests SET status = ?, media_status = ?, updated = CASE WHEN status != ? THEN ? ELSE updated END, checked = ? WHERE id = ?",
                 [st, ms || null, st, clock(), clock(), row.id]);
  if (["declined", "failed", "removed"].includes(st) && row.status !== st) await refund(row.id, st === "removed" ? "was removed" : `was ${st}`);
  if (st !== row.status) await notifyChange({ ...row, status: st });
  return st;
}
async function notifyChange(row) {
  const inbox = require("./inbox");
  const name = `${row.title}${row.year ? ` (${row.year})` : ""}`;
  if (row.status === "available" || row.status === "partial") {
    const ok = await runQuery("UPDATE media_requests SET notified_at = ? WHERE id = ? AND notified_at IS NULL AND ? = 'available'", [clock(), row.id, row.status]);
    if (row.status === "available" && !(ok && ok.changes)) return;
    await inbox.addSafe(row.user_id, { kind: "media", title: row.status === "available" ? `🎬 ${name} is on Plex — enjoy!` : `🎬 ${name} is partly on Plex`,
      body: row.status === "available" ? "The title you requested is ready to watch." : "Some of what you requested is ready; the rest is on its way.",
      link: "/requests", ref: `mreq-${row.status}:${row.id}` });
  } else if (["declined", "failed", "removed"].includes(row.status)) {
    await inbox.addSafe(row.user_id, { kind: "media", title: `🎬 Your request for ${name} was ${row.status === "removed" ? "removed" : row.status}`,
      body: row.paid_with === "free" ? "" : "What you paid for it has been given back.", link: "/requests", ref: `mreq-${row.status}:${row.id}` });
  } else if (row.status === "approved") {
    await inbox.addSafe(row.user_id, { kind: "media", title: `🎬 ${name} was approved`, body: "It'll be on Plex once it's downloaded.", link: "/requests", ref: `mreq-approved:${row.id}` });
  }
}
async function poll({ all = false } = {}) {
  await init();
  if (!conf.keys().overseerr) return 0;
  const every = conf.get().request_poll_min * 60000;
  const rows = await getQuery(`SELECT * FROM media_requests WHERE status IN ('pending','approved','partial') AND overseerr_id IS NOT NULL
                               ${all ? "" : "AND (checked IS NULL OR checked < ?)"} ORDER BY checked LIMIT 100`, all ? [] : [clock() - every]);
  let n = 0;
  for (const row of rows) {
    try { if ((await sync(row)) !== row.status) n++; } catch (e) { if (!e.upstream) console.error("[requests] poll:", conf.errLine(e)); break; }
  }
  return n;
}
// Overseerr's webhook: a hint only - re-read the request(s) it names from the API.
async function webhook(payload) {
  await init();
  const p = payload || {};
  const rid = Number(p.request && p.request.request_id);
  const tmdb = Number(p.media && p.media.tmdbId);
  const type = p.media && (p.media.media_type === "tv" ? "tv" : p.media.media_type === "movie" ? "movie" : null);
  let rows = [];
  if (rid) rows = await getQuery("SELECT * FROM media_requests WHERE overseerr_id = ?", [rid]);
  if (!rows.length && tmdb && type) rows = await getQuery(`SELECT * FROM media_requests WHERE media_type = ? AND tmdb_id = ? AND status IN ('pending','approved','partial')`, [type, tmdb]);
  let n = 0;
  for (const row of rows.slice(0, 50)) { try { await sync(row); n++; } catch (e) { /* the poll gets it */ } }
  return n;
}

// ── the shop hook: request-credit items ──
async function onSale(sale) {
  const item = (conf.get().credit_items || {})[sale.prizeId];
  if (!item || !conf.on.requests()) return false;            // off = the item is fulfilled by hand, as before
  await init();
  await addCredits(sale.userId, item.kind, item.n);
  const shop = require("./shop");
  const what = `${item.n} ${item.kind === "tv" ? "show" : "movie"} request credit${item.n === 1 ? "" : "s"}`;
  await runQuery("UPDATE shop_orders SET seller_note = ? WHERE id = ? AND seller_note IS NULL",
                 [`${what} added to your account. Use them at ${String(process.env.PUBLIC_BASE_URL || "https://publicaccess.tv").replace(/\/+$/, "")}/requests`, sale.orderId]);
  await shop.event(sale.orderId, "completed", "system", `${what} added`);
  await require("./inbox").addSafe(sale.userId, { kind: "media", title: `🎬 ${what} added`, body: "Request movies and shows with them.", link: "/requests", ref: `mcred:${sale.orderId}` });
  return true;
}

// ── views ──
async function mine(userId) {
  await init();
  const rows = await getQuery("SELECT * FROM media_requests WHERE user_id = ? ORDER BY id DESC LIMIT 50", [userId]);
  return rows.map((r) => ({ id: r.id, type: r.media_type, tmdb: r.tmdb_id, title: r.title, year: r.year, poster: r.poster,
    seasons: r.seasons ? JSON.parse(r.seasons) : null, status: r.status, label: LABEL[r.status] || r.status, paid_with: r.paid_with, price: r.price,
    order_id: r.order_id, created: r.created, refunded: !!r.refunded_at }));
}
async function adminState() {
  await init();
  return {
    recent: await getQuery("SELECT id, username, media_type, tmdb_id, title, year, status, paid_with, price, order_id, mapped_by, overseerr_id, error, created FROM media_requests ORDER BY id DESC LIMIT 50"),
    links: await getQuery("SELECT l.user_id, u.username, l.overseerr_user, l.set_by, l.at FROM media_user_links l LEFT JOIN users u ON u.userId = l.user_id ORDER BY l.at DESC"),
  };
}
async function setLink(username, overseerrUser, actor) {
  await init();
  const u = (await getQuery("SELECT userId, username FROM users WHERE LOWER(username) = LOWER(?)", [String(username || "").trim()]))[0];
  if (!u) throw new Refuse(404, "No such PATV account.");
  if (overseerrUser === "" || overseerrUser == null) {
    await runQuery("DELETE FROM media_user_links WHERE user_id = ?", [u.userId]);
    return { username: u.username, overseerr_user: null };
  }
  if (!/^\d{1,9}$/.test(String(overseerrUser))) throw new Refuse(400, "The Overseerr user id is a number (Users → the user → the id in the address).");
  await runQuery(`INSERT INTO media_user_links (user_id, overseerr_user, set_by, at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET overseerr_user = excluded.overseerr_user, set_by = excluded.set_by, at = excluded.at`,
                 [u.userId, Number(overseerrUser), actor || null, clock()]);
  return { username: u.username, overseerr_user: Number(overseerrUser) };
}

// ── routes ──
let timer = null;
function register(app, { addUser, noTimers } = {}) {
  const guard = require("./middleware/authGuard");
  const shop = require("./shop");
  shop.onOfficialSale(onSale);
  if (!noTimers && !timer) {
    timer = setInterval(() => poll().catch((e) => console.error("[requests] poll:", conf.errLine(e))), 60 * 1000);
    timer.unref();
  }
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
    console.error("[requests]", conf.errLine(e));
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const needUser = (req, res, next) => (req.user && req.user.userId ? next() : res.status(401).json({ ok: false, error: "Sign in first." }));
  const sameSite = (req, res, next) => (guard.sameSite(req) ? next() : res.status(403).json({ ok: false, error: "cross-site request refused" }));
  const L = guard.limiter({ windowMs: 60000, max: 30 });
  const lim = (req, res, next) => {
    const k = "mreq:" + ((req.user && req.user.userId) || guard.clientIp(req));
    if (L.blocked(k)) return res.status(429).json({ ok: false, error: "Slow down a little - try again in a minute." });
    L.hit(k);
    next();
  };

  app.get("/requests", addUser, async (req, res) => {
    try {
      await init();
      const S = conf.get();
      const me = req.user && req.user.userId ? req.user : null;
      res.render("mediaRequests", { user: me ? me.username : null, on: conf.on.requests(), signedIn: !!me,
        credits: me ? await credits(me.userId) : { movie: 0, tv: 0 }, mine: me ? await mine(me.userId) : [],
        price: { movie: S.request_price_movie, tv: S.request_price_tv }, perDay: S.requests_per_day, admin: conf.isStaff(req.user) });
    } catch (e) {
      console.error("[requests] page:", conf.errLine(e));
      res.status(500).send("Couldn't load requests.");
    }
  });
  app.get("/api/requests/search", addUser, needUser, lim, async (req, res) => {
    try { res.json({ ok: true, results: await search(req.user, req.query.q, req.query.page) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/requests/title/:type/:tmdb", addUser, needUser, lim, async (req, res) => {
    try {
      if (!conf.on.requests()) throw new Refuse(403, "Requests are switched off right now.");
      res.json({ ok: true, title: await details(req.params.type, req.params.tmdb) });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/requests/mine", addUser, needUser, async (req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json({ ok: true, requests: await mine(req.user.userId), credits: await credits(req.user.userId) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/requests", addUser, needUser, sameSite, lim, async (req, res) => {
    try { res.json(await request(req.user, req.body || {})); } catch (e) { fail(res, e); }
  });
  // Overseerr -> us. Settings → Notifications → Webhook: URL https://<site>/api/requests/overseerr-webhook,
  // Authorization header = OVERSEERR_WEBHOOK_SECRET, the default JSON payload.
  app.post("/api/requests/overseerr-webhook", async (req, res) => {
    const want = env("OVERSEERR_WEBHOOK_SECRET");
    const got = String(req.get("authorization") || "");
    const a = Buffer.from(got), b = Buffer.from(want);
    if (!want || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false });
    try { res.json({ ok: true, synced: await webhook(req.body || {}) }); } catch (e) { res.json({ ok: true, synced: 0 }); }
  });
}

module.exports = { init, register, search, details, request, refund, sync, poll, webhook, onSale, credits, addCredits, requesterFor, mine, adminState, setLink,
                   statusOf, LABEL, Refuse, _setClock: (fn) => { clock = fn || (() => Date.now()); }, _resetUsers: () => { usersCache = { at: 0, list: null }; } };
