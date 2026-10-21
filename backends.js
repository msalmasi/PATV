// backends.js — 🔌 Admin › Backends (/admin/backends): the hand-overs between Pepe and publicaccess.tv, switched from the site.
//
// Owner answers 2026-10-20, (2): Pepe's local admin panel "Backends" card (pepe_backends.py) becomes READ-ONLY. The hand-overs it
// used to flip - the lotto, the stashes, the GTF records, the polls, the cosmetic drop table and the AI judge - are switched
// HERE, in /admin (never on a public feature page), and every switch is audited. (1): a switch that holds or moves members'
// PAT (the lotto's pot, the stashes) is a Pepe OWNER's - the Admin class AND the owner role on the linked chat login, read
// fresh (staffroles.ownerOf), like the economy writes; the GTF / polls / cosmetics / oracle switches stay Admins'.
//
// A switch here is the wish for WHERE the feature lives - want true = on publicaccess.tv, false = on Pepe:
//   * it writes the feature's own site switch the way the old per-feature routes and tools/*-backend.js do (the site takes
//     Pepe's hand-over only while it is on); each feature's rule is in FEATURES (`apply`);
//   * it records the wish in backend_wants, which Pepe reads (POST /api/pepe/backends, bot token) to run his own hand-over
//     or way back (freeze -> export -> verify, as before). Nothing moves on the site from here.
//   * admin_audit "backend_switch" {feature, want, was, live, via} once it has committed.
// The old per-feature switch routes (/api/admin/{stash,gtf,polls}-backend, /api/admin/oracle, the cosmetic-drops switch) keep
// their rules and also record the wish + the audit row (noteLegacy). The pools / capital / escrow / gangs / achievement-counter
// cutovers stay status-only here (done live with their runbooks; their site switches are on /admin/economy and in
// tools/*-backend.js), as on Pepe's panel. The casino is per room and switched in chat (!casino backend); its engines are on
// Admin › Games.
//
//   GET  /admin/backends                the page (views/admin/backends.ejs, public/js/admin-backends.js) - Admins
//   GET  /api/admin/backends            the rows as JSON - Admins
//   POST /api/admin/backends/:feature   {on: true|false}  a same-origin fetch; Admins, + a Pepe owner on an owner row
//   POST /api/pepe/backends             {password} (bot token) -> {ok, ts, features: {key: {want, live, site, by, at}}}
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");

const CAP = "econ.backend_cutover";                 // the Admin capability every switch needs (siteperms.js, locked: Admins)
const DOCS = "https://github.com/msalmasi/PATV/blob/staging/docs/";

class Refuse extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; this.refuse = true; }
}
let clock = () => Date.now();

// a feature's own switch row, written like tools/*-backend.js do (every one of these tables is (key PRIMARY KEY, value JSON))
const metaWrite = (table, key, v) => runQuery(`INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                                             [key, JSON.stringify(v)]);
const lotto = () => require("./lotto/service");
const stashes = () => require("./stashes");
const gtf = () => require("./gtfstore");
const polls = () => require("./polls");
const cos = () => require("./cosmetics");
const oracle = () => require("./oracle");

/**
 * The hand-overs Pepe's panel used to flip. owner: the switch holds / moves members' PAT (a Pepe owner's). prep: the module's
 * tables exist (run BEFORE the transaction - a module's first CREATE outside it would wait at the write gate). live: the site
 * owns it now. site: the feature's own site switch (null = it has none). apply(on, live): the site-side effect, inside the
 * transaction (throws a Refuse to refuse; -> {pepe: true} when only Pepe can act on it now).
 */
const FEATURES = {
  lotto: {
    owner: true, doc: "lotto-cutover-runbook.md",
    prep: () => lotto().ensure(),
    live: async () => !!(await lotto().loadSettings(true)).lotto_backend,
    site: async () => null,
    // the lotto has no separate site switch: Pepe's cutover (the import) turns lotto_backend on and his rollback (the export)
    // turns it off - between draws, with the pot booked under one key. The wish is all that is written.
    apply: async () => ({ pepe: true }),
  },
  stashes: {
    owner: true, doc: null,
    prep: () => stashes().init(),
    live: () => stashes().live(),
    site: () => stashes().enabled(),
    apply: async (on, live) => {
      if (live) throw new Refuse(409, "E_LIVE", "The site owns the stashes for good (the import) - there is nothing to switch. Only a detach on Pepe, when the site is gone.");
      await metaWrite("stash_meta", "enabled", !!on);
      return {};
    },
  },
  gtf: {
    owner: false, doc: "gtf-backend.md",
    prep: () => gtf().init(),
    live: () => gtf().live(),
    site: () => gtf().enabled(),
    // off never takes the records away from a live site: it refuses new imports, and Pepe's way back releases them
    apply: async (on, live) => { await metaWrite("gtf_meta", "enabled", !!on); return { pepe: !on && !!live }; },
  },
  polls: {
    owner: false, doc: null,
    prep: () => polls().backendEnabled(),
    live: () => polls().backendLive(),
    site: () => polls().backendEnabled(),
    // as the old switch: off ends the site's ownership at once (the running poll stays on the site until Pepe detaches)
    apply: async (on) => { await metaWrite("polls_meta", "enabled", !!on); return {}; },
  },
  cosdrops: {
    owner: false, doc: null,
    prep: () => cos().dropEnabled(),
    live: () => cos().dropLive(),
    site: () => cos().dropEnabled(),
    // while the site owns the table only Pepe releases it (his drop knobs get the same numbers back): the wish is recorded
    apply: async (on, live) => {
      if (!on && live) return { pepe: true };
      await metaWrite("cosmetic_drop_meta", "enabled", !!on);
      return {};
    },
  },
  aijudge: {
    owner: false, doc: null,
    prep: () => oracle().init(),
    live: () => oracle().enabled(),
    site: () => oracle().enabled(),
    // the site's oracle switch: on = Pepe's judge proposes here; off = proposals are refused and he decides locally
    apply: async (on) => { await metaWrite("oracle_meta", "enabled", !!on); return {}; },
  },
};
const KEYS = Object.keys(FEATURES);

// Status only (cutovers done live with their runbooks; their switches: /admin/economy, tools/*-backend.js)
const STATUS_ONLY = {
  pools: { doc: "pools-cutover-runbook.md", mod: () => require("./pools") },
  capital: { doc: "capital-cutover-runbook.md", mod: () => require("./capital/core") },
  escrow: { doc: "escrow-cutover-runbook.md", mod: () => require("./escrow/ledger") },
  gangs: { doc: "gangs-cutover-runbook.md", mod: () => require("./gangs") },
  achievements: { doc: "achievements-cutover-runbook.md", mod: () => require("./achprogress") },
};

let ready = null;
function init() {
  if (!ready) {
    ready = runQuery(`CREATE TABLE IF NOT EXISTS backend_wants (feature TEXT PRIMARY KEY, want INTEGER NOT NULL, by TEXT, by_user TEXT,
                      via TEXT, at INTEGER NOT NULL)`)
      .then(() => require("./adminaudit").init())
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function wants() {
  await init();
  const out = {};
  for (const r of await getQuery("SELECT feature, want, by, via, at FROM backend_wants")) {
    out[r.feature] = { want: !!r.want, by: r.by || null, via: r.via || null, at: Number(r.at) || null };
  }
  return out;
}
const putWant = (key, on, me, via) => runQuery(`INSERT INTO backend_wants (feature, want, by, by_user, via, at) VALUES (?, ?, ?, ?, ?, ?)
                                                ON CONFLICT(feature) DO UPDATE SET want = excluded.want, by = excluded.by,
                                                by_user = excluded.by_user, via = excluded.via, at = excluded.at`,
                                               [key, on ? 1 : 0, String((me && me.username) || "?").slice(0, 80), (me && me.userId) || null, via, clock()]);
const audit = (me, detail) => require("./adminaudit").record({ userId: (me && me.userId) || "?", username: (me && me.username) || null }, "backend_switch", null, detail)
  .catch((e) => console.error("[backends] audit:", e && e.message));

/** Who may switch `key`: a Refuse, or null. `me`: a users row read fresh. */
async function mayFlip(me, key) {
  const f = FEATURES[key];
  if (!f) return new Refuse(404, "unknown", "No such backend switch here.");
  if (!me || !SP.can(me, CAP)) return new Refuse(403, "admin_only", "Admins only.");
  if (f.owner) {
    const SR = require("./staffroles");
    if (!(await SR.ownerOf(me, CAP))) return new Refuse(403, "owner_only", SR.OWNER_ONLY);
  }
  return null;
}

/**
 * Switch one hand-over (the caller has checked mayFlip and the same-origin rule). The feature's own site switch + the wish
 * in ONE transaction (the site's live state read inside it), then the audit row. -> {feature, want, live, site, pepe}
 */
async function flip(key, on, me, { via = "web" } = {}) {
  const f = FEATURES[key];
  if (!f) throw new Refuse(404, "unknown", "No such backend switch here.");
  on = !!on;
  await init();
  await f.prep();
  const before = (await wants())[key] || null;
  const r = await tx(async () => {
    const live = !!(await f.live());
    const res = (await f.apply(on, live)) || {};
    await putWant(key, on, me, via);
    return { live, pepe: !!res.pepe };
  });
  await audit(me, { feature: key, want: on, was: before ? before.want : null, live: r.live, via });
  console.log(`[backends] ${key}: ${on ? "to the site" : "to Pepe"} by ${(me && me.username) || "?"} (${via}; live ${r.live})`);
  return { feature: key, want: on, live: r.live, site: await f.site(), pepe: r.pepe };
}

/** The old per-feature switch routes: after their own write, the same wish + audit row (they keep their own rules). */
async function noteLegacy(user, key, on) {
  try {
    if (!FEATURES[key] || !user || !user.userId) return;
    await init();
    const me = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [user.userId]).catch(() => []))[0] || user;
    const before = (await wants())[key] || null;
    await putWant(key, !!on, me, "web-legacy");
    let live = null;
    try { live = !!(await FEATURES[key].live()); } catch (e) { live = null; }
    await audit(me, { feature: key, want: !!on, was: before ? before.want : null, live, via: "web-legacy" });
  } catch (e) { console.error("[backends] legacy note:", e && e.message); }
}

/** Every row: the hand-overs (switchable) and the status-only cutovers. `me` (optional) adds can / why per row. */
async function view(me) {
  await init();
  const W = await wants();
  const SR = require("./staffroles");
  const owner = me ? !!(await SR.ownerOf(me, CAP).catch(() => null)) : false;
  const admin = !!(me && SP.can(me, CAP));
  const rows = [];
  for (const key of KEYS) {
    const f = FEATURES[key];
    let live = null, site = null, err = null;
    try { await f.prep(); live = !!(await f.live()); site = await f.site(); } catch (e) { err = String((e && e.message) || e).slice(0, 160); }
    const w = W[key] || null;
    rows.push({ key, owner: !!f.owner, live, site: site === null || site === undefined ? null : !!site, want: w ? w.want : null,
                by: w ? w.by : null, via: w ? w.via : null, at: w ? w.at : null, doc: f.doc ? DOCS + f.doc : null, error: err,
                can: admin && (!f.owner || owner), waiting: !!(w && live !== null && w.want !== live) });
  }
  const status = [];
  for (const [key, s] of Object.entries(STATUS_ONLY)) {
    let live = null, site = null, err = null;
    try {
      const M = s.mod();
      if (typeof M.init === "function") await M.init();
      live = !!(await M.live());
      site = !!(await M.enabled());
    } catch (e) { err = String((e && e.message) || e).slice(0, 160); }
    status.push({ key, live, site, doc: DOCS + s.doc, error: err });
  }
  return { rows, status, owner, admin };
}

/** Pepe's read (bot token): the wish per hand-over + where it lives now. want null = never switched here. */
async function botView() {
  await init();
  const W = await wants();
  const features = {};
  for (const key of KEYS) {
    const f = FEATURES[key];
    let live = null, site = null;
    try { await f.prep(); live = !!(await f.live()); site = await f.site(); } catch (e) { live = null; }
    const w = W[key] || null;
    features[key] = { want: w ? w.want : null, live, site: site === null || site === undefined ? null : !!site, by: w ? w.by : null, at: w ? w.at : null };
  }
  return { ok: true, ts: clock(), features };
}

async function meOf(req) {
  if (!req.user || !req.user.userId) return null;
  return (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0] || null;
}

function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[backends] init:", e.message));
  const guard = require("./middleware/authGuard");
  const noStore = (res) => { res.set("Cache-Control", "no-store"); res.set("X-Robots-Tag", "noindex"); };

  app.get("/admin/backends", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/admin/backends"));
    try {
      const me = await meOf(req);
      noStore(res);
      if (!SP.can(me, CAP)) {
        if (typeof req.flash === "function") req.flash("error", "Backends are for site admins.");
        return res.redirect((me && SP.areaHome(me)) || "/login");
      }
      res.render("admin/backends", { title: "Admin · Backends", user: me.username, isAdmin: true, me, V: await view(me) });
    } catch (e) { console.error("[backends] page:", e); res.status(500).send("Couldn't load the admin page."); }
  });
  app.get("/api/admin/backends", addUser, async (req, res) => {
    noStore(res);
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!SP.can(me, CAP)) return res.status(403).json({ ok: false, code: "admin_only", error: "Admins only." });
    try { res.json(Object.assign({ ok: true }, await view(me))); }
    catch (e) { console.error("[backends] view:", e); res.status(500).json({ ok: false, code: "internal", error: "Something went wrong." }); }
  });
  app.post("/api/admin/backends/:feature", addUser, async (req, res) => {
    noStore(res);
    if (!guard.sameOriginFetch(req)) return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    const b = req.body || {};
    if (b.on !== true && b.on !== false) return res.status(400).json({ ok: false, code: "bad_request", error: "Say on (true) or off (false)." });
    try {
      const no = await mayFlip(me, String(req.params.feature || ""));
      if (no) throw no;
      res.json(Object.assign({ ok: true }, await flip(String(req.params.feature), b.on, me)));
    } catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, code: e.code || "refused", error: e.message });
      console.error("[backends] flip:", e);
      res.status(500).json({ ok: false, code: "internal", error: "Something went wrong - nothing changed." });
    }
  });
  app.post("/api/pepe/backends", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    if (typeof isBotToken !== "function" || !isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await botView()); } catch (e) { console.error("[backends] bot:", e); res.status(500).json({ ok: false, error: "server_error" }); }
  });
}

module.exports = { init, register, view, botView, flip, mayFlip, noteLegacy, wants, FEATURES, STATUS_ONLY, KEYS, CAP, Refuse,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
