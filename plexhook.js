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
//       catalog - the sync reads media-control as always. The thumbnail is skipped unread (the parser has no file handler, so
//       busboy makes no stream for it), never buffered or written. Every other event (media.play / pause / resume / stop /
//       scrobble / rate, library.on.deck, admin.*, device.new, playback.started, ...) -> 200, ignored: counted in memory per event
//       name, never written to the database (an active server sends one per play / pause / stop).
//     * catalog_hook_server (optional) = one Plex server's machine identifier: only its library.new acts. The site can't read
//       its own server's identifier (media-control doesn't hand it out), so until an admin picks one any server holding the URL
//       counts; the admin card lists the servers seen in recent library.new deliveries (in memory only) to pick from.
//     * Rate limits per IP and overall (deliveries with the right secret), a cap on the whole body (MAX_BODY) and on the payload
//       field (MAX_PAYLOAD), multipart only. Parsed with busboy itself, not multer 1.x (review 1.99anw: multer took the parser's
//       listeners off on a limit, and a malformed part header after it was an unhandled 'error' that ended the site's process).
//     * The card keeps two records: the last new-title message (library.new: when, and what happened to it - kept in plex_hook,
//       so it survives a restart) and the last delivery of any kind (memory only), plus per-event counts of the ignored ones.
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
const Busboy = require("busboy");

const PATH = "/api/plex/webhook/";
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;               // 32 random bytes, base64url
const SERVER_RE = /^[A-Za-z0-9]{8,64}$/;                // a Plex machine identifier (media-control's own check)
const EVENT_RE = /^[a-z][a-z0-9._-]{0,39}$/i;
const MAX_BODY = 4 * 1024 * 1024;     // the whole delivery - a poster thumbnail is the big part (drained, never kept)
const MAX_PAYLOAD = 256 * 1024;       // the payload field (a few KB in practice)
const LIMITS = { perIp: 120, all: 600, windowMs: 60000 };   // a season added at once is a burst of library.new; one is enough
const SECRET_TTL_MS = 60000;          // the kept secret is read again after this (another process may have made a new one)
const SERVERS_KEPT = 5;
const IGNORED_KEPT = 24;              // distinct event names counted (past it: "unknown") - memory only
const PARTS = { fields: 4, files: 2, parts: 6, fieldName: 64 };
const OUTCOMES = ["scheduled", "joined", "after", "ignored", "switch_off", "catalog_off", "other_server", "unavailable",
  "bad_request", "too_large", "rate_limited"];
const SAY = {
  scheduled: (s) => "changes-only catalog sync in " + s + " s",
  joined: (s) => "joined the catalog sync due in " + s + " s",
  after: () => "a sync is running - one more after it",
  ignored: () => "ignored",
  switch_off: () => "ignored (the webhook is switched off)",
  catalog_off: () => "ignored (the catalog is off)",
  other_server: () => "ignored (another Plex server)",
  unavailable: () => "ignored (the catalog is unavailable)",
  bad_request: () => "refused (not a Plex webhook delivery)",
  too_large: () => "refused (too large)",
  rate_limited: () => "refused (rate limit)",
};
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
  let last = null;                       // the last delivery of any kind {at, event, outcome} - memory only
  let lastNew = null, lastNewRead = false;   // the last library.new {at, outcome} - plex_hook "last_new" (survives a restart)
  const ignored = new Map();             // event name -> {n, at}: the ignored deliveries since the site started (memory only)
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
  // review 1.99anw: one record for the last library.new (what the card is for: did the new title arrive, and what became of
  // it) and one for the last delivery of any kind. Only the first is written to myapp.db - a playback event is counted in
  // memory, never a database write per play / pause / stop on a busy server.
  function record(event, outcome, due) {
    const at = now();
    last = { at, event, outcome };
    if (event === "library.new") {
      lastNew = { at, outcome };
      lastNewRead = true;
      store.put("last_new", JSON.stringify(lastNew)).catch(() => {});
    }
    if (outcome === "ignored") {
      const name = ignored.has(event) || ignored.size < IGNORED_KEPT ? event : "unknown";
      const v = ignored.get(name) || { n: 0, at: 0 };
      ignored.set(name, { n: v.n + 1, at });
    }
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
  /** The payload field ({payload}: a string, or null when the body had none), or a coded error: too_large (over a cap, on the
   *  wire or in a part) / bad_request (not multipart, malformed, cut off). busboy itself, not multer 1.x (review 1.99anw): on a
   *  limit multer took every listener off busboy (removeAllListeners), so a malformed part header further on in the same body
   *  was an 'error' event with no listener - an exception that ended the site's process. Here the parser's 'error' listener
   *  stays on for the parser's whole life; a refused body is unpiped from it and its rest drained by linger(). There is no
   *  'file' listener: busboy then skips each file part (the thumbnail) without making a stream - its bytes are counted against
   *  the body cap and dropped, never buffered. */
  function parse(req) {
    return new Promise((resolve, reject) => {
      let seen = 0, done = false, bb = null, payload = null;
      const finish = (code) => {
        if (done) return;
        done = true;
        req.removeListener("data", count); req.removeListener("error", gone); req.removeListener("close", closed);
        if (bb) { try { req.unpipe(bb); } catch (_) { /* not piped */ } }
        if (code) reject(coded(code)); else resolve({ payload });
      };
      // the whole body, chunked or not (a Content-Length over the cap was refused before reading)
      const count = (chunk) => { seen += chunk.length; if (seen > maxBody) finish("too_large"); };
      const gone = () => finish("bad_request");
      const closed = () => { if (!req.complete) finish("bad_request"); };   // the sender went away mid-body
      req.on("data", count); req.on("error", gone); req.on("close", closed);
      try { bb = Busboy({ headers: req.headers, limits: { fieldSize: maxPayload, fields: PARTS.fields, files: PARTS.files, parts: PARTS.parts } }); }
      catch (_) { return finish("bad_request"); }
      bb.on("error", () => finish("bad_request"));   // never removed (see above)
      bb.on("field", (name, value, info) => {
        if (String(name == null ? "" : name).length > PARTS.fieldName || (info && (info.nameTruncated || info.valueTruncated))) return finish("too_large");
        if (name === "payload" && payload == null) payload = value;
      });
      for (const limit of ["partsLimit", "filesLimit", "fieldsLimit"]) bb.on(limit, () => finish("too_large"));
      bb.on("close", () => finish(null));
      req.pipe(bb);
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
    try { p = typeof fields.payload === "string" ? JSON.parse(fields.payload) : null; } catch (_) { p = null; }
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
    if (!lastNewRead) {
      try {
        const v = JSON.parse((await store.get("last_new")) || "null");
        if (v && Number.isFinite(Number(v.at)) && OUTCOMES.includes(v.outcome)) lastNew = { at: Number(v.at), outcome: v.outcome };
      } catch (_) { /* no record yet */ }
      lastNewRead = true;
    }
    let catalogOn = false, pending = null;
    try { catalogOn = !!catalog.inUse(cfg); } catch (_) { catalogOn = false; }
    try { pending = catalog.hookState(); } catch (_) { pending = null; }
    const want = typeof cfg.catalog_hook_server === "string" && SERVER_RE.test(cfg.catalog_hook_server) ? cfg.catalog_hook_server : "";
    return { ok: true, url: s ? origin() + PATH + s : null, on: cfg.catalog_hook !== false, catalog_on: catalogOn,
      debounce_s: Math.max(10, Math.min(600, Math.floor(Number(cfg.catalog_hook_debounce_s) || 30))),
      gap_min: Math.max(1, Math.min(60, Math.floor(Number(cfg.catalog_hook_gap_min) || 5))), server: want,
      servers: [...servers].reverse().map(([id, v]) => ({ id, name: v.name, n: v.n, at: v.at, pinned: id === want })),
      last_new: lastNew, last, ignored: [...ignored].map(([event, v]) => ({ event, n: v.n, at: v.at })).sort((a, b) => b.n - a.n || b.at - a.at),
      wrong: wrong.n ? { n: wrong.n, at: wrong.at } : null,
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
