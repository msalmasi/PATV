// plexhook.js — 1.99anw: Plex's webhook keeps the video clerk's catalog fresh. Before it, a title Plex added reached the catalog
// (plexcatalog.js) at the timer's next changes-only sync only (catalog_sync_min, 60 minutes by default).
//
//   POST /api/plex/webhook/<secret>   Plex Media Server -> the site (Plex Web → Settings → Webhooks → Add Webhook; needs Plex Pass).
//                                     Plex sends multipart/form-data: a `payload` JSON field and, on some events, a `thumb` image.
//     * The secret is the only key (Plex can't send a header of ours): 32 random bytes made once and kept in the plex_hook table
//       (myapp.db - never a setting, a log line, a page's HTML or a response to anyone but an admin), compared in constant time.
//       A wrong or missing one is passed on (next()): the answer is the site's own "not found", the same as an address that
//       doesn't exist, and nothing here limits, parses or logs more than a count.
//     * ONLY "library.new" acts, and all it does is ask the catalog for its ordinary changes-only sync, soon (plexcatalog.soon():
//       debounced, single-flight, the quiet window respected, nothing when the catalog is off). The payload is read for the event
//       name and the Plex server's identifier / name (Server.uuid / .title) and is never stored; nothing in it reaches the
//       catalog - the sync reads media-control as always. The thumbnail is drained unread (multer's fileFilter says no), never
//       buffered or written. Every other event (media.play / pause / resume / stop / scrobble / rate, library.on.deck, admin.*,
//       device.new, playback.started, ...) -> 200, ignored.
//     * catalog_hook_server (optional) = one Plex server's machine identifier: only its library.new acts. The site can't read
//       its own server's identifier (media-control doesn't hand it out), so until an admin picks one any server holding the URL
//       counts; the admin card lists the servers seen in recent library.new deliveries (in memory only) to pick from.
//     * Rate limits per IP and overall (deliveries with the right secret), a cap on the whole body (MAX_BODY) and on the payload
//       field (MAX_PAYLOAD), multipart only.
//     * One short log line per delivery: the event name and what happened - never the secret, a title or the payload.
//     * index.js registers it before the cookie / session / body middleware (like Sign in with Apple's server-to-server
//       notifications): Plex sends no cookie and no Origin, so no CSRF / origin check applies and no session is made for it. The
//       site has no maintenance gate in front of it; Cloudflare + the nginx origin lock pass a POST to publicaccess.tv like the
//       Stripe and Overseerr webhooks'.
//   GET  /api/media/admin/catalog/hook             the admin card on /admin/media (media.admin): the URL (the secret is made on
//                                                  the first view), the switches, the last delivery, the servers seen, a wait
//   POST /api/media/admin/catalog/hook/regenerate  a new secret - the old URL is "not found" from then on
//   POST /api/media/admin/catalog/hook/server      {server: "<machine identifier>" | ""} - only that server's events / any server
"use strict";
const crypto = require("crypto");

const PATH = "/api/plex/webhook/";
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;               // 32 random bytes, base64url
const SERVER_RE = /^[A-Za-z0-9]{8,64}$/;                // a Plex machine identifier (media-control's own check)
const EVENT_RE = /^[a-z][a-z0-9._-]{0,39}$/i;
const MAX_BODY = 4 * 1024 * 1024;     // the whole delivery - a poster thumbnail is the big part (drained, never kept)
const MAX_PAYLOAD = 256 * 1024;       // the payload field (a few KB in practice)
const LIMITS = { perIp: 120, all: 600, windowMs: 60000 };   // a season added at once is a burst of library.new; one is enough
const SECRET_TTL_MS = 60000;          // the kept secret is read again after this (another process may have made a new one)
const SERVERS_KEPT = 5;
const OUTCOMES = ["scheduled", "joined", "after", "ignored", "switch_off", "catalog_off", "other_server", "unavailable",
  "bad_request", "too_large", "rate_limited"];
const SAY = {
  scheduled: (s) => "changes-only catalog sync in " + s + " s",
  joined: (s) => "joined the catalog sync due in " + s + " s",
  after: () => "a sync is running - one more right after it",
  ignored: () => "ignored",
  switch_off: () => "ignored (the webhook is switched off)",
  catalog_off: () => "ignored (the catalog is off)",
  other_server: () => "ignored (another Plex server)",
  unavailable: () => "ignored (the catalog is unavailable)",
  bad_request: () => "refused (not a Plex webhook delivery)",
  too_large: () => "refused (too large)",
  rate_limited: () => "refused (rate limit)",
};
const TOO_BIG = new Set(["LIMIT_FIELD_VALUE", "LIMIT_FILE_SIZE", "LIMIT_PART_COUNT", "LIMIT_FIELD_COUNT", "LIMIT_FILE_COUNT", "LIMIT_FIELD_KEY"]);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const newSecret = () => crypto.randomBytes(32).toString("base64url");
const clean = (v, max) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const coded = (code) => Object.assign(new Error(code), { code });
/** The site's public origin (the URL Plex is given): never a short link (pa.tv answers a redirect, which a POST doesn't follow). */
const siteOrigin = () => String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL ||
  (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");

/** The secret and the last delivery, in myapp.db (per environment: deploy/keep-staging-tables.js keeps staging's own). */
function dbStore() {
  const { runQuery, getQuery } = require("./dbUtils");
  let ready = null;
  const init = () => ready || (ready = runQuery("CREATE TABLE IF NOT EXISTS plex_hook (k TEXT PRIMARY KEY, v TEXT NOT NULL)").catch((e) => { ready = null; throw e; }));
  return {
    async get(k) { await init(); const r = (await getQuery("SELECT v FROM plex_hook WHERE k = ?", [k]))[0]; return r ? r.v : null; },
    async put(k, v) { await init(); await runQuery("INSERT INTO plex_hook (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, v]); },
    async putIfMissing(k, v) { await init(); await runQuery("INSERT OR IGNORE INTO plex_hook (k, v) VALUES (?, ?)", [k, v]); },
  };
}

function createHook(deps = {}) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const settings = deps.settings || (() => require("./mediaconf").get());
  const catalog = deps.catalog || require("./plexcatalog");
  const store = deps.store || dbStore();
  const guard = deps.guard || require("./middleware/authGuard");
  const origin = deps.origin || siteOrigin;
  const lim = { ...LIMITS, ...(deps.limits || {}) };
  const maxBody = deps.maxBody || MAX_BODY, maxPayload = deps.maxPayload || MAX_PAYLOAD;
  const ipLimit = guard.limiter({ max: lim.perIp, windowMs: lim.windowMs });
  const allLimit = guard.limiter({ max: lim.all, windowMs: lim.windowMs });
  let kept = null;                       // {secret, at}
  let last = null, lastRead = false;     // the last delivery {at, event, outcome}
  const servers = new Map();             // machine identifier -> {name, n, at}: library.new deliveries since the site started
  const wrong = { n: 0, at: null, logged: 0 };
  let limitedLogged = 0;

  // ── the secret ──
  async function secret({ fresh = false } = {}) {
    if (!fresh && kept && now() - kept.at < SECRET_TTL_MS) return kept.secret;
    const v = await store.get("secret");
    kept = { secret: SECRET_RE.test(v || "") ? v : null, at: now() };
    return kept.secret;
  }
  /** The secret, made the first time an admin opens the card. */
  async function ensureSecret() {
    const have = await secret({ fresh: true });
    if (have) return have;
    await store.putIfMissing("secret", newSecret());
    return secret({ fresh: true });
  }
  async function regenerate() {
    const s = newSecret();
    await store.put("secret", s);
    kept = { secret: s, at: now() };
    return s;
  }
  async function secretOk(given) {
    if (typeof given !== "string" || !SECRET_RE.test(given)) return false;
    let want = null;
    try { want = await secret(); } catch (_) { return false; }
    return !!want && crypto.timingSafeEqual(sha(given), sha(want));
  }

  // ── what happened ──
  function record(event, outcome, due) {
    last = { at: now(), event, outcome };
    lastRead = true;
    if (outcome !== "rate_limited") store.put("last", JSON.stringify(last)).catch(() => {});
    if (outcome === "rate_limited") { if (now() - limitedLogged < 60000) return; limitedLogged = now(); }
    const s = due ? Math.max(0, Math.round((due - now()) / 1000)) : 0;
    log.log("[plexhook] " + event + ": " + SAY[outcome](s));
  }
  function noteWrong() {
    wrong.n++; wrong.at = now();
    if (now() - wrong.logged >= 60000) { wrong.logged = now(); log.log("[plexhook] a webhook request with a wrong or missing secret (answered not found)"); }
  }
  function sawServer(id, name) {
    const v = servers.get(id) || { name: "", n: 0, at: 0 };
    servers.delete(id);
    servers.set(id, { name: name || v.name, n: v.n + 1, at: now() });
    while (servers.size > SERVERS_KEPT) servers.delete(servers.keys().next().value);
  }

  // ── the delivery ──
  let upload = null;
  function parser() {
    if (!upload) {
      const multer = require("multer");
      upload = multer({ storage: multer.memoryStorage(),
        limits: { fieldNameSize: 64, fieldSize: maxPayload, fields: 4, files: 2, parts: 6, fileSize: maxBody, headerPairs: 40 },
        fileFilter: (req, file, cb) => cb(null, false) }).any();   // the thumbnail: drained unread, never kept
    }
    return upload;
  }
  /** multer's fields, or a coded error: too_large (over a cap, on the wire or in a field) / bad_request. */
  function parse(req) {
    return new Promise((resolve, reject) => {
      let seen = 0, done = false;
      const finish = (e, v) => { if (done) return; done = true; req.removeListener("data", count); if (e) reject(e); else resolve(v); };
      // the whole body, chunked or not (a Content-Length over the cap was refused before reading): past the cap the parser
      // is let go (unpiped) and the rest is drained by refuse() below
      const count = (chunk) => { seen += chunk.length; if (seen > maxBody) { req.unpipe(); finish(coded("too_large")); } };
      req.on("data", count);
      try {
        parser()(req, {}, (e) => finish(e ? coded(e.code && TOO_BIG.has(e.code) ? "too_large" : "bad_request") : null, req.body));
      } catch (_) { finish(coded("bad_request")); }
    });
  }
  /** A refused delivery's unread rest is read and thrown away (at most twice the cap, for at most 5 s - then the connection is
   *  cut), so the caller reads the answer instead of a reset connection. */
  function linger(req) {
    if (req.complete) return;
    let drained = 0;
    const cut = () => { try { req.destroy(); } catch (_) { /* gone already */ } };
    const t = setTimeout(cut, 5000);
    if (t.unref) t.unref();
    const stop = () => clearTimeout(t);
    req.on("data", (chunk) => { drained += chunk.length; if (drained > 2 * maxBody) { stop(); cut(); } });
    req.on("end", stop); req.on("close", stop); req.on("error", stop);
    req.resume();
  }
  /** The route (express 4 doesn't catch a rejected handler: anything unexpected is a 500, never an unhandled rejection). */
  function handle(req, res, next) {
    deliver(req, res, next).catch(() => { try { if (!res.headersSent) res.status(500).json({ ok: false }); } catch (_) { /* gone */ } });
  }
  async function deliver(req, res, next) {
    let ok = false;
    try { ok = await secretOk(req.params.secret); } catch (_) { ok = false; }
    if (!ok) { noteWrong(); return next(); }
    res.set("Cache-Control", "no-store");
    const refuse = (status, outcome) => {
      record("-", outcome);
      linger(req);
      return res.status(status).json({ ok: false });
    };
    const ip = guard.clientIp(req);
    const wait = ipLimit.attempt(ip) || allLimit.attempt("all");   // an address over its own limit doesn't use up everyone's
    if (wait) { res.set("Retry-After", String(wait)); return refuse(429, "rate_limited"); }
    if (!/^multipart\/form-data\s*;/i.test(String(req.get("content-type") || ""))) return refuse(415, "bad_request");
    const len = Number(req.get("content-length"));
    if (req.get("content-length") != null && Number.isFinite(len) && len > maxBody) return refuse(413, "too_large");
    let fields;
    try { fields = await parse(req); } catch (e) { return refuse(e.code === "too_large" ? 413 : 400, e.code === "too_large" ? "too_large" : "bad_request"); }
    let p = null;
    try { p = fields && typeof fields.payload === "string" ? JSON.parse(fields.payload) : null; } catch (_) { p = null; }
    if (!p || typeof p !== "object" || Array.isArray(p)) return refuse(400, "bad_request");
    const event = typeof p.event === "string" && EVENT_RE.test(p.event) ? p.event : "unknown";
    const say = (outcome, due) => { record(event, outcome, due); return res.json({ ok: true, outcome }); };
    if (event !== "library.new") return say("ignored");
    const sv = p.Server && typeof p.Server === "object" ? p.Server : {};
    const server = typeof sv.uuid === "string" && SERVER_RE.test(sv.uuid) ? sv.uuid : null;
    if (server) sawServer(server, clean(sv.title, 60));
    const cfg = settings() || {};
    if (cfg.catalog_hook === false) return say("switch_off");
    const want = typeof cfg.catalog_hook_server === "string" && SERVER_RE.test(cfg.catalog_hook_server) ? cfg.catalog_hook_server : "";
    if (want && server !== want) return say("other_server");
    let r = null;
    try { r = catalog.soon(); } catch (_) { r = null; }
    const outcome = { scheduled: "scheduled", after: "after", joined: "joined", off: "catalog_off" }[r && r.state] || "unavailable";
    return say(outcome, r && r.due);
  }

  // ── the admin card ──
  async function view() {
    const s = await ensureSecret();
    const cfg = settings() || {};
    if (!lastRead) {
      try {
        const v = JSON.parse((await store.get("last")) || "null");
        if (v && Number.isFinite(Number(v.at)) && OUTCOMES.includes(v.outcome) && (v.event === "-" || EVENT_RE.test(String(v.event || ""))))
          last = { at: Number(v.at), event: String(v.event), outcome: v.outcome };
      } catch (_) { /* no record yet */ }
      lastRead = true;
    }
    let catalogOn = false, pending = null;
    try { catalogOn = !!catalog.inUse(cfg); } catch (_) { catalogOn = false; }
    try { pending = catalog.hookState(); } catch (_) { pending = null; }
    const want = typeof cfg.catalog_hook_server === "string" && SERVER_RE.test(cfg.catalog_hook_server) ? cfg.catalog_hook_server : "";
    return { ok: true, url: s ? origin() + PATH + s : null, on: cfg.catalog_hook !== false, catalog_on: catalogOn,
      debounce_s: Math.max(10, Math.min(600, Math.floor(Number(cfg.catalog_hook_debounce_s) || 30))), server: want,
      servers: [...servers].reverse().map(([id, v]) => ({ id, name: v.name, n: v.n, at: v.at, pinned: id === want })),
      last, wrong: wrong.n ? { n: wrong.n, at: wrong.at } : null,
      pending: pending && pending.waiting ? { due: pending.due, after_running: !!pending.after_running } : null };
  }

  function registerEarly(app) {
    app.post(PATH + ":secret", handle);
  }
  function registerAdmin(app, { addUser } = {}) {
    const SP = deps.permissions || require("./siteperms");
    const conf = deps.conf || require("./mediaconf");
    const audit = deps.audit || ((...a) => require("./adminaudit").record(...a));
    const pass = (req, res, next) => next();
    const admin = (req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (!SP.can(req.user, "media.admin")) return res.status(403).json({ ok: false, error: "Admins only." });
      if (req.method === "POST" && !guard.sameOriginFetch(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
      next();
    };
    const J = (fn) => [addUser || pass, admin, async (req, res) => {
      try { res.json(await fn(req)); } catch (e) {
        if (e && e.refuse) return res.status(400).json({ ok: false, error: e.message });
        log.error("[plexhook] admin: " + String((e && e.code) || "error"));
        res.status(500).json({ ok: false, error: "Something went wrong." });
      }
    }];
    app.get("/api/media/admin/catalog/hook", ...J(() => view()));
    app.post("/api/media/admin/catalog/hook/regenerate", ...J(async (req) => {
      await regenerate();
      log.log("[plexhook] webhook secret regenerated by " + clean(String((req.user && req.user.username) || "?"), 48) + " - the old URL no longer works");
      await Promise.resolve(audit(req.user, "plex_hook_secret", null, { regenerated: true })).catch(() => {});
      return view();
    }));
    app.post("/api/media/admin/catalog/hook/server", ...J(async (req) => {
      const v = String(((req.body || {}).server) == null ? "" : (req.body || {}).server).trim();
      if (v && !SERVER_RE.test(v)) throw Object.assign(new Error("That isn't a Plex server identifier."), { refuse: true });
      await conf.init();
      const before = conf.get().catalog_hook_server || "";
      const r = await conf.set({ catalog_hook_server: v }, req.user.username);
      if (r.changed.length) await Promise.resolve(audit(req.user, "media_settings", null, { catalog_hook_server: { from: before, to: r.settings.catalog_hook_server } })).catch(() => {});
      return view();
    }));
  }
  return { handle, registerEarly, registerAdmin, view, regenerate, ensureSecret, secretOk, servers };
}

let singleton = null;
const current = () => singleton || (singleton = createHook());
module.exports = { createHook, dbStore, siteOrigin, PATH, MAX_BODY, MAX_PAYLOAD, LIMITS, OUTCOMES,
  registerEarly: (app) => current().registerEarly(app), registerAdmin: (app, opts) => current().registerAdmin(app, opts) };
