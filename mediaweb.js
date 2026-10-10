// mediaweb.js — 1.99ji: wires the Plex / media integrations into the site and serves their admin page.
//   /admin/media                  settings (all OFF by default), connection checks, 📼 the library player for any pad,
//                                 the play log, requests + Overseerr user links, the Wizarr invite queue
//   /api/media/admin/*            the page's JSON actions (site admins only; same-site POSTs)
// The player itself is medialib.js (/api/medialib/*), requests mediarequests.js (/requests), invites mediainvites.js.
"use strict";
const conf = require("./mediaconf");
const lib = require("./medialib");
const reqs = require("./mediarequests");
const inv = require("./mediainvites");

const env = (k) => String(process.env[k] || "").trim();

// connection checks: says reachable / not, never echoes a key or a body
async function checks() {
  const K = conf.keys();
  const out = { mediactl: null, overseerr: null, wizarr: null };
  if (K.mediactl) {
    try {
      const r = await lib.call("GET", "/streams", null, { timeout: 6000 });
      out.mediactl = r.status === 200 ? { ok: true, streams: ((r.json && r.json.streams) || []).length }
        : { ok: false, error: r.status === 401 ? "signature refused (MEDIACTL_SECRET / clock)" : `answered ${r.status}` };
    } catch (e) { out.mediactl = { ok: false, error: conf.errLine(e) }; }
  }
  const get = async (base, p, hdr) => {
    try {
      const r = await fetch(base.replace(/\/+$/, "") + p, { headers: { Accept: "application/json", ...hdr }, signal: AbortSignal.timeout(6000), redirect: "error" });
      let j = null; try { j = await r.json(); } catch (e) { /* not JSON */ }
      return r.status === 200 ? { ok: true, version: (j && j.version) || null } : { ok: false, error: `answered ${r.status}` };
    } catch (e) { return { ok: false, error: "can't be reached" }; }
  };
  if (K.overseerr) out.overseerr = await get(env("OVERSEERR_URL"), "/api/v1/settings/about", { "X-Api-Key": env("OVERSEERR_API_KEY") });
  if (K.wizarr) out.wizarr = await get(env("WIZARR_URL"), "/api/status", { "X-API-Key": env("WIZARR_API_KEY") });
  return out;
}

function register(app, { addUser, noTimers } = {}) {
  const guard = require("./middleware/authGuard");
  const rooms = require("./rooms");
  lib.register(app, { addUser, noTimers });
  reqs.register(app, { addUser, noTimers });
  inv.register(app, { noTimers });
  Promise.all([lib.init(), reqs.init(), inv.init()]).catch((e) => console.error("[media] setup:", conf.errLine(e)));

  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
    console.error("[media]", conf.errLine(e));
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const admin = (req, res, next) => {
    if (!conf.isAdmin(req.user)) return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    next();
  };
  const J = (fn) => [addUser, admin, async (req, res) => { try { res.set("Cache-Control", "no-store"); res.json(await fn(req)); } catch (e) { fail(res, e); } }];

  app.get("/admin/media", addUser, async (req, res) => {
    if (!conf.isAdmin(req.user)) return res.redirect("/login");
    try {
      await Promise.all([conf.init(), reqs.init(), inv.init(), lib.init()]);
      const pads = (await rooms.list()).map((r) => ({ id: r.id, title: r.title }));
      res.render("mediaAdmin", { user: req.user.username, S: conf.get(), K: conf.keys(), pads, house: rooms.HOUSE_ROOM,
        requests: await reqs.adminState(), invites: await inv.adminState(), libraryOk: conf.libraryAllowed(req.user),
        plays: await require("./dbUtils").getQuery(`SELECT id, ts, username, room_id, title, quality, offset_start, ended_at, end_reason, error, price, charge, access
                                                    FROM media_plays ORDER BY id DESC LIMIT 100`) });
    } catch (e) {
      console.error("[media] admin page:", conf.errLine(e));
      res.status(500).send("Couldn't load the media admin.");
    }
  });
  app.get("/api/media/admin/checks", ...J(async () => ({ ok: true, keys: conf.keys(), checks: await checks() })));
  app.post("/api/media/admin/settings", ...J(async (req) => {
    const r = await conf.set(req.body || {}, req.user.username);
    require("./mainstage").setLibraryIdle(r.settings.library_pause_max_min);
    return { ok: true, settings: r.settings, changed: r.changed, on: { library: conf.on.library(), requests: conf.on.requests(), invites: conf.on.invites() } };
  }));
  app.post("/api/media/admin/link", ...J(async (req) => ({ ok: true, ...(await reqs.setLink((req.body || {}).username, (req.body || {}).overseerr_user, req.user.username)) })));
  app.post("/api/media/admin/requests/poll", ...J(async () => ({ ok: true, changed: await reqs.poll({ all: true }) })));
  app.post("/api/media/admin/invites/:id/retry", ...J(async (req) => inv.adminRetry(req.params.id, req.user.username)));
  app.post("/api/media/admin/invites/:id/sent", ...J(async (req) => inv.adminSent(req.params.id, (req.body || {}).text, req.user.username)));
  app.get("/api/media/admin/wizarr-catalog", ...J(async () => ({ ok: true, ...(await inv.catalog()) })));
}

module.exports = { register, checks };
