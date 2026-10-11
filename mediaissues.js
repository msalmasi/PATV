// mediaissues.js — 1.99la: 🛠️ report a problem with a Plex title, and the 🎟️ curators' manage view.
//
// REPORTING (on /plex): a title that's on our Plex server (Seerr says available / partly available) - found by search,
// from your requests, or from "recently added" - gets "Report a problem": video / audio / subtitles / other, an optional
// season / episode, and a message. It becomes a Seerr Issue (POST /api/v1/issue, the Seerr MEDIA id resolved from the
// title's TMDB id) made on behalf of their linked Seerr user when there is one (requestroles.seerrUserFor), else by the
// API key's owner with "Reported on PATV by <name>" in front. Seerr's own Discord / email notifications then fire.
// You see your reports here with their status (open / resolved) and the comments; you can add a comment.
//   Who may report: signed-in PATV accounts that are Plex members (plexmembers: an active linked share), plus curators
//   and admins - the problems are about OUR server, only people who watch on it can see them, and it keeps drive-by spam
//   out of the admins' Discord. Limits: 5 reports per 24 h per account, one open report per title, 10 calls a minute.
//
// MANAGING (/plex/manage - active 🎟️ curators and site admins, checked server-side on every call):
//   * every Seerr request (pending / approved / available / ... ), approve or decline - sent as the curator's own Seerr
//     user (X-API-User) once their Seerr permissions are in place, else with the admin key; the PATV request row follows
//     at once (mediarequests.webhook), so declines are refunded the usual way
//   * every Seerr issue: resolve / reopen / comment
//   Every action is in request_role_log.
//
// On staging nothing is written to Seerr (reports are stored locally only and say so).
//
//   media_issues   one row per report made from PATV
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const conf = require("./mediaconf");

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}
let clock = () => Date.now();
const MIN = 60000, DAY = 86400000;
const TYPES = { video: 1, audio: 2, subtitles: 3, other: 4 };
const TYPE_NAME = { 1: "video", 2: "audio", 3: "subtitles", 4: "other" };
const REQ_STATUS = { 1: "pending", 2: "approved", 3: "declined", 4: "failed", 5: "completed" };
const REQ_FILTERS = ["all", "pending", "approved", "processing", "available", "unavailable", "failed", "completed"];
const DAILY = 5;

let seerr = (...a) => require("./mediarequests").api(...a);
const MR = () => require("./mediarequests");
const RR = () => require("./requestroles");

// ── storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await conf.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS media_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT, seerr_id INTEGER, media_id INTEGER,
        media_type TEXT NOT NULL, tmdb_id INTEGER NOT NULL, title TEXT, year INTEGER, poster TEXT,
        issue_type INTEGER NOT NULL, season INTEGER, episode INTEGER, message TEXT, status TEXT NOT NULL, seerr_user INTEGER,
        dry INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL, checked INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS media_issues_user ON media_issues (user_id, id)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── titles (Seerr lists carry TMDB ids, not names): local request rows first, then Seerr, cached ──
const titleCache = new Map();
async function titleOf(type, tmdb) {
  const k = `${type}/${tmdb}`;
  const c = titleCache.get(k);
  if (c && clock() - c.at < 12 * 3600000) return c.v;
  let v = null;
  const local = (await getQuery("SELECT title, year, poster FROM media_requests WHERE media_type = ? AND tmdb_id = ? ORDER BY id DESC LIMIT 1", [type, Number(tmdb)]).catch(() => []))[0];
  if (local) v = { title: local.title, year: local.year, poster_url: MR().posterUrl(local.poster) };
  else {
    try { const d = await MR().details(type, tmdb); v = { title: d.title, year: d.year, poster_url: MR().posterUrl(d.poster) }; }
    catch (e) { v = { title: `${type === "tv" ? "Show" : "Movie"} #${tmdb}`, year: null, poster_url: null }; }
  }
  if (titleCache.size > 800) titleCache.clear();
  titleCache.set(k, { at: clock(), v });
  return v;
}

// ── the library: search + recently added (titles that are on Plex) ──
async function librarySearch(q) {
  if (!conf.keys().overseerr) throw new Refuse(503, "The request server isn't set up.");
  q = String(q || "").trim().slice(0, 100);
  if (q.length < 2) throw new Refuse(400, "Type at least 2 characters.");
  const r = await seerr("GET", `/search?query=${encodeURIComponent(q).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}&page=1&language=en`);
  if (r.status !== 200 || !r.json) throw new Refuse(502, "The request server didn't answer the search.");
  return (r.json.results || []).filter((x) => (x.mediaType === "movie" || x.mediaType === "tv") && x.mediaInfo && [4, 5].includes(x.mediaInfo.status))
    .slice(0, 20).map((x) => ({ type: x.mediaType, tmdb: x.id, title: x.title || x.name || "?", year: /^\d{4}/.test(x.releaseDate || x.firstAirDate || "") ? Number(String(x.releaseDate || x.firstAirDate).slice(0, 4)) : null,
      poster_url: MR().posterUrl(x.posterPath), partial: x.mediaInfo.status === 4 }));
}
let recentCache = { at: 0, list: null };
async function recent() {
  if (recentCache.list && clock() - recentCache.at < 10 * MIN) return recentCache.list;
  if (!conf.keys().overseerr) return [];
  const r = await seerr("GET", "/media?filter=allavailable&take=12&skip=0&sort=mediaAdded");
  if (r.status !== 200 || !r.json) return recentCache.list || [];
  const out = [];
  for (const m of (r.json.results || []).slice(0, 12)) {
    if (!["movie", "tv"].includes(m.mediaType) || !m.tmdbId) continue;
    out.push({ type: m.mediaType, tmdb: m.tmdbId, ...(await titleOf(m.mediaType, m.tmdbId)), partial: m.status === 4 });
  }
  recentCache = { at: clock(), list: out };
  return out;
}

// ── who may report ──
async function mayReport(user) {
  if (!user || !user.userId) return false;
  if (await RR().canManage(user)) return true;
  const pm = require("./plexmembers");
  return !!(await pm.memberFor(user.userId).catch(() => null));
}

// ── report ──
async function report(user, b = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!conf.keys().overseerr) throw new Refuse(503, "The request server isn't set up.");
  if (!(await mayReport(user))) throw new Refuse(403, "Reporting problems is for Plex members — link your Plex account first.");
  const type = b.type === "tv" ? "tv" : b.type === "movie" ? "movie" : null;
  if (!type || !/^\d{1,9}$/.test(String(b.tmdb))) throw new Refuse(400, "Pick a title.");
  const issueType = TYPES[String(b.issue_type || "")];
  if (!issueType) throw new Refuse(400, "Pick what's wrong: video, audio, subtitles or other.");
  const message = String(b.message || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  if (message.length < 5) throw new Refuse(400, "Say a little about the problem (at least 5 characters).");
  const season = type === "tv" && /^\d{1,3}$/.test(String(b.season || "")) ? Number(b.season) : 0;
  const episode = season && /^\d{1,4}$/.test(String(b.episode || "")) ? Number(b.episode) : 0;
  const t = clock();
  const today = (await getQuery("SELECT COUNT(*) AS n FROM media_issues WHERE user_id = ? AND created > ?", [user.userId, t - DAY]))[0].n;
  if (today >= DAILY) throw new Refuse(429, `That's ${today} reports in the last 24 hours — the most for now.`);
  if ((await getQuery("SELECT id FROM media_issues WHERE user_id = ? AND media_type = ? AND tmdb_id = ? AND status = 'open'", [user.userId, type, Number(b.tmdb)]))[0]) {
    throw new Refuse(409, "You already have an open report for that title — add a comment to it instead.");
  }
  const d = await seerr("GET", `/${type}/${Number(b.tmdb)}?language=en`);
  if (d.status === 404) throw new Refuse(404, "That title isn't known.");
  if (d.status !== 200 || !d.json) throw new Refuse(502, "The request server didn't answer.");
  const mi = d.json.mediaInfo || {};
  if (!mi.id || ![4, 5].includes(mi.status)) throw new Refuse(409, "That title isn't on our Plex server — request it instead.");
  const name = d.json.title || d.json.name || "?";
  const year = /^\d{4}/.test(d.json.releaseDate || d.json.firstAirDate || "") ? Number(String(d.json.releaseDate || d.json.firstAirDate).slice(0, 4)) : null;
  const me = (await getQuery("SELECT username FROM users WHERE userId = ?", [user.userId]))[0] || { username: user.username };
  let who = null;
  try { const w = await RR().seerrUserFor(user.userId, { allowImport: false }); if (w && w.id) who = w.id; } catch (e) { /* the admin key reports it */ }
  const dry = !RR().writable();
  let seerrId = null;
  if (!dry) {
    const body = { mediaId: mi.id, issueType, message: who ? message : `Reported on PATV by ${me.username}: ${message}`,
                   problemSeason: season, problemEpisode: episode, ...(who && who !== 1 ? { userId: who } : {}) };
    const r = await seerr("POST", "/issue", body);
    if (r.status !== 201 && r.status !== 200) throw new Refuse(502, "The request server didn't take the report — try again in a bit.");
    seerrId = (r.json && r.json.id) || null;
  }
  const row = await runQuery(`INSERT INTO media_issues (user_id, username, seerr_id, media_id, media_type, tmdb_id, title, year, poster, issue_type, season, episode,
                                message, status, seerr_user, dry, created, updated, checked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    [user.userId, me.username, seerrId, mi.id, type, Number(b.tmdb), name, year, d.json.posterPath || null, issueType, season || null, episode || null,
     message, who, dry ? 1 : 0, t, t, t]);
  console.log(`[issues] ${me.username} reported ${TYPE_NAME[issueType]} on ${type} ${b.tmdb} "${name}" -> Seerr issue ${dry ? "(staging: not sent)" : "#" + seerrId}${who ? " as #" + who : ""}`);
  return { ok: true, id: row.id, seerr_id: seerrId, dry };
}

// ── your reports (status + comments from Seerr, cached a little) ──
const issueCache = new Map();
async function seerrIssue(id, { fresh = false } = {}) {
  const c = issueCache.get(id);
  if (!fresh && c && clock() - c.at < 2 * MIN) return c.v;
  const r = await seerr("GET", `/issue/${id}`);
  const v = r.status === 200 && r.json ? r.json : r.status === 404 || r.status === 500 ? { gone: true } : null;
  if (v) { if (issueCache.size > 500) issueCache.clear(); issueCache.set(id, { at: clock(), v }); }
  return v;
}
const commentsOf = (iss) => ((iss && iss.comments) || []).map((c) => ({
  by: (c.user && (c.user.displayName || c.user.plexUsername || c.user.username)) || "?", at: c.createdAt ? Date.parse(c.createdAt) : null,
  message: String(c.message || "").slice(0, 1000) }));
async function mine(userId) {
  await init();
  const rows = await getQuery("SELECT * FROM media_issues WHERE user_id = ? ORDER BY id DESC LIMIT 20", [userId]);
  const out = [];
  for (const r of rows) {
    let comments = [];
    if (r.seerr_id && conf.keys().overseerr) {
      const iss = await seerrIssue(r.seerr_id).catch(() => null);
      if (iss && iss.gone) { if (r.status !== "removed") await runQuery("UPDATE media_issues SET status = 'removed', updated = ? WHERE id = ?", [clock(), r.id]); r.status = "removed"; }
      else if (iss) {
        const st = iss.status === 2 ? "resolved" : "open";
        if (st !== r.status) {
          await runQuery("UPDATE media_issues SET status = ?, updated = ?, checked = ? WHERE id = ?", [st, clock(), clock(), r.id]);
          if (st === "resolved") await require("./inbox").addSafe(r.user_id, { kind: "media", title: `🛠️ Your report on ${r.title} was resolved`, body: "Thanks for telling us.", link: "/plex#issues", ref: `missue-res:${r.id}` }).catch(() => {});
          r.status = st;
        }
        comments = commentsOf(iss);
      }
    }
    out.push({ id: r.id, seerr_id: r.seerr_id, type: r.media_type, tmdb: r.tmdb_id, title: r.title, year: r.year, poster_url: MR().posterUrl(r.poster),
      issue_type: TYPE_NAME[r.issue_type] || "other", season: r.season, episode: r.episode, message: r.message, status: r.status, dry: !!r.dry,
      created: r.created, comments });
  }
  return out;
}
async function comment(user, localOrSeerrId, message, { manager = false } = {}) {
  await init();
  message = String(message || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  if (message.length < 2) throw new Refuse(400, "Write a comment first.");
  let seerrId;
  if (manager) seerrId = Number(localOrSeerrId);
  else {
    const r = (await getQuery("SELECT * FROM media_issues WHERE id = ? AND user_id = ?", [Number(localOrSeerrId), user.userId]))[0];
    if (!r) throw new Refuse(404, "That report isn't yours.");
    seerrId = r.seerr_id;
  }
  if (!seerrId) throw new Refuse(409, "That report never reached the request server (staging).");
  if (!RR().writable()) return { ok: true, dry: true };
  const r = await seerr("POST", `/issue/${seerrId}/comment`, { message: `${manager ? "PATV curator " : "PATV "}${user.username}: ${message}` });
  if (r.status !== 200 && r.status !== 201) throw new Refuse(502, "The request server didn't take the comment.");
  issueCache.delete(seerrId);
  if (manager) await RR().log(user.userId, "curator", "issue_comment", user.username, { issue: seerrId });
  return { ok: true };
}

// ── managing (curators + admins) ──
async function asActor(user) {
  // a curator acts as their own Seerr user once their Seerr permissions are in place; an admin (or not yet) = the API key
  if (conf.isAdmin(user)) return null;
  const row = (await getQuery("SELECT seerr_user, seerr_state FROM request_roles WHERE user_id = ? AND role = 'curator' AND status = 'active'", [user.userId]))[0];
  return row && row.seerr_state === "applied" && row.seerr_user ? row.seerr_user : null;
}
async function manageRequests(filter, page) {
  if (!conf.keys().overseerr) throw new Refuse(503, "The request server isn't set up.");
  const f = REQ_FILTERS.includes(filter) ? filter : "pending";
  const p = Math.max(1, Math.min(50, Number(page) || 1));
  const r = await seerr("GET", `/request?take=20&skip=${(p - 1) * 20}&filter=${f}&sort=added`);
  if (r.status !== 200 || !r.json) throw new Refuse(502, "The request server didn't answer.");
  const out = [];
  for (const q of r.json.results || []) {
    const m = q.media || {};
    const type = m.mediaType || q.type;
    const local = (await getQuery("SELECT username FROM media_requests WHERE overseerr_id = ? LIMIT 1", [q.id]).catch(() => []))[0];
    out.push({ id: q.id, status: REQ_STATUS[q.status] || "pending", media: MR().MEDIA[m.status] || "unknown", type, tmdb: m.tmdbId,
      ...(await titleOf(type, m.tmdbId)), by: (q.requestedBy && (q.requestedBy.displayName || q.requestedBy.plexUsername)) || "?",
      patv: local ? local.username : null, seasons: (q.seasons || []).map((s) => s.seasonNumber), created: q.createdAt ? Date.parse(q.createdAt) : null });
  }
  return { filter: f, page: p, pages: (r.json.pageInfo && r.json.pageInfo.pages) || 1, requests: out };
}
async function decide(user, id, verb) {
  if (!["approve", "decline"].includes(verb)) throw new Refuse(400, "Approve or decline.");
  if (!/^\d{1,9}$/.test(String(id))) throw new Refuse(400, "Bad request id.");
  if (!RR().writable()) { await RR().log(user.userId, "curator", verb + "_dry", user.username, { request: Number(id) }); return { ok: true, dry: true }; }
  const asUser = await asActor(user);
  const r = await seerr("POST", `/request/${Number(id)}/${verb}`, null, { asUser });
  if (r.status !== 200 && r.status !== 201) {
    const msg = (r.json && r.json.message) || `answered ${r.status}`;
    throw new Refuse(r.status === 403 || r.status === 404 ? r.status : 502, `The request server refused: ${String(msg).slice(0, 120)}`);
  }
  await RR().log(user.userId, "curator", verb, user.username, { request: Number(id), as_seerr_user: asUser });
  await MR().webhook({ request: { request_id: Number(id) } }).catch(() => {});     // the PATV row (and a decline's refund) follows now
  return { ok: true };
}
async function manageIssues(filter, page) {
  if (!conf.keys().overseerr) throw new Refuse(503, "The request server isn't set up.");
  const f = ["open", "resolved", "all"].includes(filter) ? filter : "open";
  const p = Math.max(1, Math.min(50, Number(page) || 1));
  const r = await seerr("GET", `/issue?take=20&skip=${(p - 1) * 20}&filter=${f}&sort=added`);
  if (r.status !== 200 || !r.json) throw new Refuse(502, "The request server didn't answer.");
  const out = [];
  for (const i of r.json.results || []) {
    const m = i.media || {};
    const local = (await getQuery("SELECT username FROM media_issues WHERE seerr_id = ? LIMIT 1", [i.id]).catch(() => []))[0];
    const full = await seerrIssue(i.id).catch(() => null);
    out.push({ id: i.id, issue_type: TYPE_NAME[i.issueType] || "other", status: i.status === 2 ? "resolved" : "open", type: m.mediaType, tmdb: m.tmdbId,
      ...(await titleOf(m.mediaType, m.tmdbId)), season: i.problemSeason || null, episode: i.problemEpisode || null,
      by: (i.createdBy && (i.createdBy.displayName || i.createdBy.plexUsername)) || "?", patv: local ? local.username : null,
      created: i.createdAt ? Date.parse(i.createdAt) : null, comments: commentsOf(full && !full.gone ? full : i) });
  }
  return { filter: f, page: p, pages: (r.json.pageInfo && r.json.pageInfo.pages) || 1, issues: out };
}
async function setIssueStatus(user, id, status) {
  if (!["resolved", "open"].includes(status)) throw new Refuse(400, "Resolve or reopen.");
  if (!/^\d{1,9}$/.test(String(id))) throw new Refuse(400, "Bad issue id.");
  if (!RR().writable()) return { ok: true, dry: true };
  const r = await seerr("POST", `/issue/${Number(id)}/${status}`, null, { asUser: await asActor(user) });
  if (r.status !== 200 && r.status !== 201) throw new Refuse(502, `The request server refused (answered ${r.status}).`);
  issueCache.delete(Number(id));
  await RR().log(user.userId, "curator", "issue_" + status, user.username, { issue: Number(id) });
  return { ok: true };
}

// ── routes ──
function register(app, { addUser } = {}) {
  const guard = require("./middleware/authGuard");
  init().catch((e) => console.error("[issues] setup:", conf.errLine(e)));
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
    console.error("[issues]", conf.errLine(e));
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const needUser = (req, res, next) => (req.user && req.user.userId ? next() : res.status(401).json({ ok: false, error: "Sign in first." }));
  const sameSite = (req, res, next) => (guard.sameSite(req) ? next() : res.status(403).json({ ok: false, error: "cross-site request refused" }));
  const L = guard.limiter({ windowMs: 60000, max: 10 });
  const ML = guard.limiter({ windowMs: 60000, max: 60 });
  const lim = (L_) => (req, res, next) => {
    const k = "miss:" + ((req.user && req.user.userId) || guard.clientIp(req));
    if (L_.blocked(k)) return res.status(429).json({ ok: false, error: "Slow down a little - try again in a minute." });
    L_.hit(k);
    next();
  };
  const manager = async (req, res, next) => {
    try { if (await RR().canManage(req.user)) return next(); } catch (e) { /* no */ }
    res.status(403).json({ ok: false, error: "Curators and admins only." });
  };
  const J = (fn) => async (req, res) => { try { res.set("Cache-Control", "no-store"); res.json(await fn(req)); } catch (e) { fail(res, e); } };

  app.get("/api/plex/library/search", addUser, needUser, lim(L), J(async (req) => ({ ok: true, results: await librarySearch(req.query.q) })));
  app.get("/api/plex/library/recent", addUser, needUser, J(async () => ({ ok: true, results: await recent() })));
  app.get("/api/plex/issues/mine", addUser, needUser, J(async (req) => ({ ok: true, may: await mayReport(req.user), issues: await mine(req.user.userId) })));
  app.post("/api/plex/issues", addUser, needUser, sameSite, lim(L), J(async (req) => report(req.user, req.body || {})));
  app.post("/api/plex/issues/:id/comment", addUser, needUser, sameSite, lim(L), J(async (req) => comment(req.user, req.params.id, (req.body || {}).message)));

  app.get("/plex/manage", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=%2Fplex%2Fmanage");
    if (!(await RR().canManage(req.user).catch(() => false))) return res.status(403).render("plexManage", { user: req.user.username, allowed: false, title: "Manage requests" });
    res.set("Cache-Control", "no-store");
    res.render("plexManage", { user: req.user.username, allowed: true, title: "Manage requests", admin: conf.isAdmin(req.user), writable: RR().writable() });
  });
  app.get("/api/plex/manage/requests", addUser, needUser, manager, lim(ML), J(async (req) => ({ ok: true, ...(await manageRequests(req.query.filter, req.query.page)) })));
  app.post("/api/plex/manage/requests/:id/:verb", addUser, needUser, sameSite, manager, lim(ML), J(async (req) => decide(req.user, req.params.id, req.params.verb)));
  app.get("/api/plex/manage/issues", addUser, needUser, manager, lim(ML), J(async (req) => ({ ok: true, ...(await manageIssues(req.query.filter, req.query.page)) })));
  app.post("/api/plex/manage/issues/:id/comment", addUser, needUser, sameSite, manager, lim(ML), J(async (req) => comment(req.user, req.params.id, (req.body || {}).message, { manager: true })));
  app.post("/api/plex/manage/issues/:id/:status", addUser, needUser, sameSite, manager, lim(ML), J(async (req) => setIssueStatus(req.user, req.params.id, req.params.status)));
}

module.exports = {
  init, register, report, mine, comment, librarySearch, recent, mayReport, manageRequests, decide, manageIssues, setIssueStatus, titleOf, TYPES, Refuse,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _set: (o) => { if (o.seerr) seerr = o.seerr; titleCache.clear(); issueCache.clear(); recentCache = { at: 0, list: null }; },
};
