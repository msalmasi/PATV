// Room Dock rollout. Cached per process, off by default; changing the audience never grants pad access.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");
const guard = require("./middleware/authGuard");
const FIELDS = Object.freeze({ mode: { def: "off", choices: ["off", "staff", "everyone"] },
  cfstickers: { def: false }, gifs: { def: false } });
const DEFAULTS = Object.freeze({ mode: "off", cfstickers: false, gifs: false });
const AUDIT = "paddock_cfg";
let ready = null, saving = Promise.resolve(), CFG = { v: 0, cfg: { ...DEFAULTS }, at: null };
let adminHits = guard.limiter({ max: 20, windowMs: 60000 });
class Refuse extends Error { constructor(status, code) { super(code); this.refuse = true; this.status = status; } }
function normalize(input, { base = DEFAULTS } = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const cfg = {}, errors = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    const old = base[key] == null ? field.def : base[key];
    if (!Object.prototype.hasOwnProperty.call(src, key)) { cfg[key] = old; continue; }
    const value = typeof src[key] === "string" ? src[key].trim().toLowerCase() : src[key];
    if (field.choices ? field.choices.includes(value) : typeof value === "boolean") cfg[key] = value;
    else { cfg[key] = old; errors[key] = "invalid"; }
  }
  return { cfg, errors };
}
function init() {
  if (!ready) ready = (async () => {
    await runQuery(`CREATE TABLE IF NOT EXISTS paddock_cfg (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL,
      data TEXT NOT NULL, updated_at INTEGER)`);
    const row = (await getQuery("SELECT v, data, updated_at FROM paddock_cfg WHERE id=1"))[0];
    if (row) {
      let data = {}; try { data = JSON.parse(row.data) || {}; } catch (e) { /* corrupt settings remain off */ }
      CFG = { v: Number(row.v) || 0, cfg: normalize(data).cfg, at: row.updated_at || null };
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}
function current() { return { v: CFG.v, cfg: { ...CFG.cfg } }; }
function viewerOn(user) { return CFG.cfg.mode === "everyone" || CFG.cfg.mode === "staff" && SP.can(user, "pads.manage_any"); }
async function save(user, body = {}) {
  if (!SP.can(user, "pads.config")) throw new Refuse(403, "denied");
  await init();
  const key = String(user.userId || user.username || "").toLowerCase();
  if (adminHits.blocked(key)) throw new Refuse(429, "rate");
  adminHits.hit(key);
  const task = saving.then(async () => {
    const result = normalize(body.cfg, { base: CFG.cfg });
    if (body.reset !== true && Object.keys(result.errors).length) throw new Refuse(400, "invalid");
    const cfg = body.reset === true ? { ...DEFAULTS } : result.cfg, changed = {};
    for (const key of Object.keys(FIELDS)) if (cfg[key] !== CFG.cfg[key]) changed[key] = [CFG.cfg[key], cfg[key]];
    await require("./adminaudit").init();
    const at = Date.now();
    const v = await tx(async () => {
      const old = (await getQuery("SELECT v FROM paddock_cfg WHERE id=1"))[0];
      const next = (old ? Number(old.v) || 0 : CFG.v) + 1;
      await runQuery(`INSERT INTO paddock_cfg (id,v,data,updated_at) VALUES (1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET v=excluded.v,data=excluded.data,updated_at=excluded.updated_at`, [next, JSON.stringify(cfg), at]);
      await require("./adminaudit").record(user, AUDIT, null, { action: body.reset === true ? "reset" : "save", v: next, changed, to: cfg },
        body.reason ? String(body.reason).slice(0, 200) : null);
      return next;
    });
    CFG = { v, cfg, at };
    return { v, cfg: { ...cfg }, changed };
  });
  saving = task.catch(() => {});
  return task;
}
async function view() {
  await init();
  return { ...current(), defaults: { ...DEFAULTS }, fields: FIELDS, updated_at: CFG.at,
    audit: await require("./adminaudit").recent(AUDIT, 15) };
}
function register(app, { addUser }) {
  init().catch(e => console.error("[paddock] init:", e.message));
  const admin = (req, res, next) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "signin" });
    if (!SP.can(req.user, "pads.config")) return res.status(403).json({ ok: false, error: "denied" });
    next();
  };
  const fetchOnly = (req, res, next) => guard.sameSite(req) && req.get("X-Requested-With") === "fetch" ? next() :
    res.status(403).json({ ok: false, error: "security" });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message });
    console.error("[paddock]", e);
    return res.status(500).json({ ok: false, error: "unavailable" });
  };
  app.get("/api/admin/paddock", addUser, admin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...await view() }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/paddock", addUser, admin, fetchOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { const result = await save(req.user, req.body || {}); res.json({ ok: true, ...result, view: await view() }); }
    catch (e) { fail(res, e); }
  });
}
module.exports = { FIELDS, DEFAULTS, init, normalize, current, save, view, viewerOn, register,
  _reset: () => { ready = null; saving = Promise.resolve(); CFG = { v: 0, cfg: { ...DEFAULTS }, at: null }; adminHits = guard.limiter({ max: 20, windowMs: 60000 }); } };
