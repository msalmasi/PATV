// cmdswitch.js — 🎛️ Pepe's command switches (1.99vc): one table of every command and feature, for site Admins.
//
//   /admin/pepe/commands   the page (views/admin/pepeCommands.ejs): every command / feature Pepe has, its category, an
//                          AI-cost badge, the MASTER switch (off = off in every room, whatever a room or its pad owner set),
//                          the GLOBAL DEFAULT rooms follow, and how many rooms have their own setting. Search, filters,
//                          bulk actions ("turn off all AI image commands"), and the change log.
//
// Pepe owns the switches (camfrog-bot pepe_cmdswitch.py - his command registry and help catalog generate the list, so a
// new command gets a switch by itself, ON). Same shape as roomctl.js:
//   Pepe   --POST /api/pepe/cmdswitch/state {password: bot token, state}-->  the table (every 5 min + right after a change)
//   admin  --POST /api/admin/pepe/commands {ids, field: master|default, value: on|off, reason?}--> website action(s) kind
//          "cmd.switch" [field, value, id...] (actions.js; Pepe runs it for site_admin only) + one admin_audit row
//          ("pepe_cmdswitch", adminaudit.js). Pepe audits it again on his side (cmdswitch_audit.json + his mod log).
//   admin  --GET  /api/admin/pepe/commands--> {online, state, actions, audit}
//   admin  --POST /api/admin/pepe/commands {field: "test", value: on|off}--> "cmd.switch" [test, on|off]: THAT admin's test
//          mode (1.99vn): an hour in which only they can use master-off commands (Pepe re-checks they're a Pepe admin by
//          their linked Camfrog name; it ends by itself; audited both sides). Masters bind admins otherwise.
// 1.99vn: the AI model registry's per-function on/off is in this table too (rows kind "ai_func", "ai.<func>").
// Effective value in a room = master AND (the room's own value, else the global default). The owner page shows a setting
// whose master is off as "Switched off by PATV admins" (padowner.js masters_off) with the owner's own value kept.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const guard = require("./middleware/authGuard");

const STATE_MAX = 512 * 1024;
const ONLINE_MS = 15 * 60 * 1000;          // Pepe pushes every 5 min
const RATE = { max: 30, windowMs: 60 * 1000 };
const hits = guard.limiter(RATE);
const ID_RE = /^[a-z0-9_.!-]{1,60}$/;
const CHUNK = 35;                          // ids per website action (Pepe takes 40 args)
const AI = new Set(["text", "vision", "image", "video", "audio", "voice", "stt", "web"]);

let NOW = () => Date.now();
function _setClock(fn) { NOW = fn || (() => Date.now()); }

let STATE = null;                          // {at, data}
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS pepe_cmdswitch_state (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL, data TEXT)");
      const r = (await getQuery("SELECT at, data FROM pepe_cmdswitch_state WHERE id = 1"))[0];
      if (r && !STATE) { try { STATE = { at: Number(r.at), data: JSON.parse(r.data) }; } catch (e) { STATE = null; } }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]/g, " ").trim().slice(0, n);
const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100000, Math.floor(Number(v)))) : 0);

/** Pepe's table, re-shaped to what the page shows (nothing else is kept). */
function cleanState(s) {
  if (!s || typeof s !== "object" || !Array.isArray(s.switches)) return null;
  const switches = s.switches.slice(0, 1000).map((x) => (x && typeof x === "object" && ID_RE.test(String(x.id || "")) ? {
    id: String(x.id), kind: x.kind === "command" || x.kind === "ai_func" ? x.kind : "feature",
    model_funcs: (Array.isArray(x.model_funcs) ? x.model_funcs : []).slice(0, 10).map((f) => str(f, 30)).filter((f) => /^[a-z_]{1,30}$/.test(f)), label: str(x.label, 100) || String(x.id),
    cat: /^[a-z_]{1,20}$/.test(String(x.cat || "")) ? String(x.cat) : "chat", ai: AI.has(x.ai) ? x.ai : null,
    cmds: (Array.isArray(x.cmds) ? x.cmds : []).slice(0, 20).map((c) => str(c, 30)).filter((c) => /^![a-z0-9_]{1,29}$/i.test(c)),
    passive: !!x.passive, master: x.master !== false, default: x.default !== false, has_default: x.has_default !== false,
    rooms_own: int(x.rooms_own), rooms_off: int(x.rooms_off), global_only: !!x.global_only,
    owner: (Array.isArray(x.owner) ? x.owner : []).slice(0, 10).map((k) => str(k, 30)),
    legacy: x.legacy ? str(x.legacy, 40) : null,
  } : null)).filter(Boolean);
  const categories = (Array.isArray(s.categories) ? s.categories : []).slice(0, 30)
    .filter((c) => Array.isArray(c) && /^[a-z_]{1,20}$/.test(String(c[0]))).map((c) => [String(c[0]), str(c[1], 40)]);
  const audit = (Array.isArray(s.audit) ? s.audit : []).slice(0, 40).map((a) => ({
    ts: Number(a && a.ts) > 0 ? Math.round(Number(a.ts) * 1000) : null, field: a && a.field === "default" ? "default" : "master",
    on: !!(a && a.on), by: str(a && a.by, 60), via: str(a && a.via, 20),
    ids: (Array.isArray(a && a.ids) ? a.ids : []).slice(0, 100).map((x) => str(x, 60)) }));
  const orphans = (Array.isArray(s.orphans) ? s.orphans : []).slice(0, 50).map((x) => str(x, 60));
  const testers = (Array.isArray(s.testers) ? s.testers : []).slice(0, 50)
    .map((t) => ({ login: str(t && t.login, 60).toLowerCase(), until: Number(t && t.until) > 0 ? Math.floor(Number(t.until)) : 0 }))
    .filter((t) => t.login && t.until);
  return { switches, categories, audit, orphans, testers, test_ttl: Number.isFinite(Number(s.test_ttl)) ? Math.floor(Number(s.test_ttl)) : 3600 };
}

async function setState(raw) {
  await init();
  const data = cleanState(raw);
  if (!data) return false;
  const json = JSON.stringify(data);
  if (json.length > STATE_MAX) return false;
  STATE = { at: NOW(), data };
  await runQuery("INSERT INTO pepe_cmdswitch_state (id, at, data) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, data = excluded.data",
                 [STATE.at, json]);
  return true;
}

async function view(user) {
  await init();
  const t = NOW();
  let actions = [];
  try {
    actions = await getQuery(`SELECT id, username, label, status, message, created, updated FROM pepe_actions
                              WHERE kind = 'cmd.switch' ORDER BY id DESC LIMIT 12`);
  } catch (e) { actions = []; }
  let audit = [];
  try { audit = await require("./adminaudit").recent("pepe_cmdswitch", 20); } catch (e) { audit = []; }
  let me = null;
  if (user && user.userId) {
    try { me = ((await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [user.userId]))[0] || {}).camfrogUsername || null; } catch (e) { me = null; }
  }
  const mine = me && STATE && STATE.data ? (STATE.data.testers || []).find((x) => x.login === String(me).toLowerCase() && x.until > t) : null;
  return { now: t, online: !!(STATE && t - STATE.at < ONLINE_MS), at: STATE ? STATE.at : null, state: STATE ? STATE.data : null, actions, audit,
           me: me ? String(me).toLowerCase() : null, my_test_until: mine ? mine.until : null };
}

/** 1.99vn: the acting admin's own test mode -> one "cmd.switch" [test, on|off] action (Pepe uses their linked Camfrog name). */
async function requestTest(user, value) {
  const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [user.userId]))[0] || {};
  if (!u.camfrogUsername) throw new Refuse(400, "Link your Camfrog name first - test mode is for the name you use Pepe as.");
  if (!(STATE && NOW() - STATE.at < ONLINE_MS)) throw new Refuse(409, "Pepe hasn't reported his switches lately (offline?) - try again in a few minutes.");
  const key = String(user.userId || user.username || "").toLowerCase();
  if (hits.blocked(key)) throw new Refuse(429, `Slow down - at most ${RATE.max} changes a minute.`);
  hits.hit(key);
  try {
    await require("./adminaudit").record(user, "pepe_cmdswitch", null, { field: "test", value, login: u.camfrogUsername }, null);
  } catch (e) { console.error("[cmdswitch] audit:", e.message); throw new Refuse(500, "Couldn't write the audit log - nothing was changed."); }
  try {
    return await require("./actions").queue(user.userId, { kind: "cmd.switch", args: ["test", value], tag: "pepe-commands",
      label: `Test mode ${value.toUpperCase()} (${u.camfrogUsername})` });
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.");
    throw e;
  }
}

/** An admin's change -> the queued action ids (one per CHUNK switches). */
async function request(user, b = {}) {
  await init();
  if (!user || user.class !== "Admin") throw new Refuse(403, "Admins only.");
  const field = String(b.field || "").toLowerCase();
  if (field !== "master" && field !== "default" && field !== "test") throw new Refuse(400, "Master or default?");
  const value = String(b.value || "").toLowerCase();
  if (value !== "on" && value !== "off") throw new Refuse(400, "On or off?");
  if (field === "test") return [await requestTest(user, value)];
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((x) => String(x || "").trim().toLowerCase()))].filter((x) => ID_RE.test(x));
  if (!ids.length) throw new Refuse(400, "Pick at least one command or feature.");
  if (ids.length > 400) throw new Refuse(400, "That's too many at once.");
  if (!(STATE && NOW() - STATE.at < ONLINE_MS)) throw new Refuse(409, "Pepe hasn't reported his switches lately (offline?) - try again in a few minutes.");
  const known = new Map((STATE.data.switches || []).map((s) => [s.id, s]));
  const unknown = ids.filter((x) => !known.has(x));
  if (unknown.length) throw new Refuse(404, `Pepe has no switch called ${unknown.slice(0, 3).join(", ")}.`);
  if (field === "default" && ids.some((x) => known.get(x).has_default === false)) throw new Refuse(400, "Some of those have no global default (master only).");
  const key = String(user.userId || user.username || "").toLowerCase();
  if (hits.blocked(key)) throw new Refuse(429, `Slow down - at most ${RATE.max} changes a minute.`);
  hits.hit(key);
  const reason = str(b.reason, 200) || null;
  try {
    await require("./adminaudit").record(user, "pepe_cmdswitch", null, { field, value, ids }, reason);
  } catch (e) { console.error("[cmdswitch] audit:", e.message); throw new Refuse(500, "Couldn't write the audit log - nothing was changed."); }
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const names = part.slice(0, 4).map((x) => known.get(x).label).join(", ") + (part.length > 4 ? ` +${part.length - 4}` : "");
    try {
      out.push(await require("./actions").queue(user.userId, { kind: "cmd.switch", args: [field, value, ...part], tag: "pepe-commands",
        label: `${field === "master" ? "Master" : "Default"} ${value.toUpperCase()}: ${names}` }));
    } catch (e) {
      if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.");
      throw e;
    }
  }
  return out;
}

function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[cmdswitch] init:", e.message));
  const admin = (json) => (req, res, next) => {
    if (!req.user || !req.user.userId) return json ? res.status(401).json({ ok: false, error: "Sign in first." }) : res.redirect("/login?next=/admin/pepe/commands");
    if (req.user.class !== "Admin") return json ? res.status(403).json({ ok: false, error: "Admins only." }) : res.status(403).send("Admins only.");
    next();
  };
  const fetchOnly = (req, res, next) => (guard.sameSite(req) && req.get("X-Requested-With") === "fetch"
    ? next() : res.status(403).json({ ok: false, error: "Security check failed - reload the page." }));
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message });
    console.error("[cmdswitch]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };

  app.post("/api/pepe/cmdswitch/state", async (req, res) => {
    if (!isBotToken(String((req.body || {}).password || req.get("x-bot-token") || ""))) return res.status(403).json({ error: "unauthorized" });
    try { res.json({ ok: await setState((req.body || {}).state) }); } catch (e) { console.error("[cmdswitch] state:", e.message); res.status(500).json({ ok: false }); }
  });
  app.get("/admin/pepe/commands", addUser, admin(false), async (req, res) => {
    try {
      res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      res.render("admin/pepeCommands", { user: req.user.username, title: "Admin · Pepe's commands", section: "pepe", isAdmin: true, v: await view(req.user) });
    } catch (e) { console.error("[cmdswitch] page:", e); res.status(500).send("Couldn't load the page."); }
  });
  app.get("/api/admin/pepe/commands", addUser, admin(true), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await view(req.user)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/pepe/commands", addUser, admin(true), fetchOnly, async (req, res) => {
    try { res.json({ ok: true, ids: await request(req.user, req.body || {}) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { register, setState, cleanState, view, request, init, _setClock, _reset: () => { STATE = null; }, CHUNK };
