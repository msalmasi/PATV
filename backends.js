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
// The review of the owner answers (2026-10-20, high): the page never claims Pepe acts on a switch he doesn't read. Pepe's poll
// of POST /api/pepe/backends says which hand-overs he FOLLOWS (`follows`) and reports what he did (`results`); the site keeps it
// (backend_reader, backend_wants.pepe_*). A hand-over Pepe doesn't follow (yet) shows the chat command an owner runs instead,
// and a switch that would only record a wish (the lotto; the drop table's release) is refused until he follows it - nothing
// would change. A wish carries `act`: true only when Pepe followed that feature when it was made, so a switch made before
// his update never starts a hand-over by surprise later.
// The old per-feature switch routes (/api/admin/{stash,gtf,polls}-backend, /api/admin/oracle, the cosmetic-drops switch) keep
// their rules and also record the wish + the audit row (noteLegacy). The pools / capital / escrow / gangs / achievement-counter
// / policy engines / Fed events cutovers stay status-only here (done live with their runbooks; their site switches are on
// /admin/economy and in tools/*-backend.js), as on Pepe's panel. The casino is per room and switched in chat (!casino backend);
// its engines are on Admin › Games.
//
//   GET  /admin/backends                the page (views/admin/backends.ejs, public/js/admin-backends.js) - Admins
//   GET  /api/admin/backends            the rows as JSON - Admins
//   POST /api/admin/backends/:feature   {on: true|false}  a same-origin fetch; Admins, + a Pepe owner on an owner row
//   POST /api/pepe/backends             {password, follows?, version?, results?} (bot token)
//                                       -> {ok, ts, contract, features: {key: {want, act, live, site, by, at}}}
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");

const CAP = "econ.backend_cutover";                 // the Admin capability every switch needs (siteperms.js, locked: Admins)
const DOCS = "https://github.com/msalmasi/PATV/blob/staging/docs/";
const CONTRACT = 1;                                 // POST /api/pepe/backends' shape (docs/admin-backends.md)
const READER_FRESH_MS = 15 * 60 * 1000;             // Pepe polls every few minutes: a read older than this = he isn't reading

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
 * transaction (throws a Refuse to refuse; -> {pepe: true} when only Pepe can act on it now). wishOnly(on, live): nothing is
 * written on the site - only Pepe following the wish moves it. chat: [on, off] - the owner's chat command when he doesn't.
 */
const FEATURES = {
  lotto: {
    owner: true, doc: "lotto-cutover-runbook.md", chat: ["!lotto backend cutover confirm", "!lotto backend rollback confirm"],
    prep: () => lotto().ensure(),
    live: async () => !!(await lotto().loadSettings(true)).lotto_backend,
    site: async () => null,
    // the lotto has no separate site switch: Pepe's cutover (the import) turns lotto_backend on and his rollback (the export)
    // turns it off - between draws, with the pot booked under one key. The wish is all that is written.
    apply: async () => ({ pepe: true }),
    wishOnly: () => true,
  },
  stashes: {
    owner: true, doc: null, chat: ["!stash backend on", "!stash backend off"],
    prep: () => stashes().init(),
    live: () => stashes().live(),
    site: () => stashes().enabled(),
    apply: async (on, live) => {
      if (live) throw new Refuse(409, "E_LIVE", "The site owns the stashes for good (the import) - there is nothing to switch. Only a detach on Pepe, when the site is gone.");
      await metaWrite("stash_meta", "enabled", !!on);
      return {};
    },
    wishOnly: () => false,
  },
  gtf: {
    owner: false, doc: "gtf-backend.md", chat: ["!gtf backend on", "!gtf backend off"],
    prep: () => gtf().init(),
    live: () => gtf().live(),
    site: () => gtf().enabled(),
    // off never takes the records away from a live site: it refuses new imports, and Pepe's way back releases them
    apply: async (on, live) => { await metaWrite("gtf_meta", "enabled", !!on); return { pepe: !on && !!live }; },
    wishOnly: () => false,
  },
  polls: {
    owner: false, doc: null, chat: ["!poll backend on", "!poll backend off"],
    prep: () => polls().backendEnabled(),
    live: () => polls().backendLive(),
    site: () => polls().backendEnabled(),
    // as the old switch: off ends the site's ownership at once (the running poll stays on the site until Pepe detaches)
    apply: async (on) => { await metaWrite("polls_meta", "enabled", !!on); return {}; },
    wishOnly: () => false,
  },
  cosdrops: {
    owner: false, doc: null, chat: ["!cosmetics backend on confirm", "!cosmetics backend off confirm"],
    prep: () => cos().dropEnabled(),
    live: () => cos().dropLive(),
    site: () => cos().dropEnabled(),
    // while the site owns the table only Pepe releases it (his drop knobs get the same numbers back): the wish is recorded
    apply: async (on, live) => {
      if (!on && live) return { pepe: true };
      await metaWrite("cosmetic_drop_meta", "enabled", !!on);
      return {};
    },
    wishOnly: (on, live) => !on && !!live,
  },
  aijudge: {
    owner: false, doc: null, chat: ["!aijudge backend on confirm", "!aijudge backend off confirm"],
    prep: () => oracle().init(),
    live: () => oracle().enabled(),
    site: () => oracle().enabled(),
    // the site's oracle switch: on = Pepe's judge proposes here; off = proposals are refused and he decides locally
    apply: async (on) => { await metaWrite("oracle_meta", "enabled", !!on); return {}; },
    wishOnly: () => false,
  },
};
const KEYS = Object.keys(FEATURES);

// Status only (cutovers done live with their runbooks; their switches: /admin/economy, tools/*-backend.js). `state` -> {live, site}.
const modState = (mod) => async () => {
  const M = mod();
  if (typeof M.init === "function") await M.init();
  return { live: !!(await M.live()), site: !!(await M.enabled()) };
};
const STATUS_ONLY = {
  pools: { doc: "pools-cutover-runbook.md", state: modState(() => require("./pools")) },
  capital: { doc: "capital-cutover-runbook.md", state: modState(() => require("./capital/core")) },
  escrow: { doc: "escrow-cutover-runbook.md", state: modState(() => require("./escrow/ledger")) },
  gangs: { doc: "gangs-cutover-runbook.md", state: modState(() => require("./gangs")) },
  achievements: { doc: "achievements-cutover-runbook.md", state: modState(() => require("./achprogress")) },
  // the review of the owner answers: Pepe's read-only panel lists these as switched on the site too
  policy: { doc: "policy-engines-cutover-runbook.md", state: async () => {
    const C = require("./policy/core");
    await C.init();
    const modes = Object.values(await C.engines()).map((e) => e.mode);
    return { live: modes.includes("live"), site: modes.some((m) => m !== "off") };
  } },
  fed: { doc: "fed-events-cutover-runbook.md", state: modState(() => require("./fed/service")) },
};

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS backend_wants (feature TEXT PRIMARY KEY, want INTEGER NOT NULL, by TEXT, by_user TEXT,
                      via TEXT, at INTEGER NOT NULL)`);
      const cols = new Set((await getQuery("SELECT name FROM pragma_table_info('backend_wants')")).map((r) => r.name));
      // act: Pepe followed the feature when the wish was made (he acts on those only); pepe_*: what he reported for this wish
      for (const [c, d] of [["act", "INTEGER NOT NULL DEFAULT 0"], ["pepe_at", "INTEGER"], ["pepe_ok", "INTEGER"], ["pepe_msg", "TEXT"]]) {
        if (!cols.has(c)) await runQuery(`ALTER TABLE backend_wants ADD COLUMN ${c} ${d}`);
      }
      await runQuery("CREATE TABLE IF NOT EXISTS backend_reader (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL, version TEXT, follows TEXT)");
      await require("./adminaudit").init();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Pepe's last read of the switches: {at, version, follows: [keys], fresh} (at null = he never read them). */
async function reader() {
  await init();
  const r = (await getQuery("SELECT at, version, follows FROM backend_reader WHERE id = 1"))[0];
  let follows = [];
  try { follows = JSON.parse((r && r.follows) || "[]"); } catch (e) { follows = []; }
  follows = Array.isArray(follows) ? follows.filter((k) => KEYS.includes(k)) : [];
  const at = r ? Number(r.at) || null : null;
  return { at, version: (r && r.version) || null, follows, fresh: !!at && clock() - at < READER_FRESH_MS };
}
/** Does Pepe follow `key`'s switch now (a fresh read that lists it)? */
const followsNow = (rd, key) => !!(rd && rd.fresh && rd.follows.includes(key));

async function wants() {
  await init();
  const out = {};
  for (const r of await getQuery("SELECT feature, want, by, via, at, act, pepe_at, pepe_ok, pepe_msg FROM backend_wants")) {
    out[r.feature] = { want: !!r.want, by: r.by || null, via: r.via || null, at: Number(r.at) || null, act: !!r.act,
                       pepe: r.pepe_at ? { at: Number(r.pepe_at), ok: !!r.pepe_ok, msg: r.pepe_msg || null } : null };
  }
  return out;
}
const putWant = (key, on, me, via, act) => runQuery(`INSERT INTO backend_wants (feature, want, by, by_user, via, at, act, pepe_at, pepe_ok, pepe_msg)
                                                     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
                                                     ON CONFLICT(feature) DO UPDATE SET want = excluded.want, by = excluded.by, by_user = excluded.by_user,
                                                     via = excluded.via, at = excluded.at, act = excluded.act, pepe_at = NULL, pepe_ok = NULL, pepe_msg = NULL`,
                                                    [key, on ? 1 : 0, String((me && me.username) || "?").slice(0, 80), (me && me.userId) || null, via, clock(), act ? 1 : 0]);
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
 * in ONE transaction (the site's live state read inside it), then the audit row. A switch that would only record a wish while
 * Pepe doesn't follow it is refused (409 pepe_not_following, with the chat command). -> {feature, want, live, site, pepe, act}
 */
async function flip(key, on, me, { via = "web" } = {}) {
  const f = FEATURES[key];
  if (!f) throw new Refuse(404, "unknown", "No such backend switch here.");
  on = !!on;
  await init();
  await f.prep();
  const rd = await reader();
  const act = followsNow(rd, key);
  const before = (await wants())[key] || null;
  const r = await tx(async () => {
    const live = !!(await f.live());
    if (!act && f.wishOnly(on, live)) {
      throw new Refuse(409, "pepe_not_following", `Pepe doesn't follow this switch yet, so nothing would change - a Pepe owner runs ${f.chat[on ? 0 : 1]} in chat to move it.`);
    }
    const res = (await f.apply(on, live)) || {};
    await putWant(key, on, me, via, act);
    return { live, pepe: !!res.pepe };
  });
  await audit(me, { feature: key, want: on, was: before ? before.want : null, live: r.live, via, pepe_follows: act });
  console.log(`[backends] ${key}: ${on ? "to the site" : "to Pepe"} by ${(me && me.username) || "?"} (${via}; live ${r.live}; Pepe ${act ? "follows" : "doesn't follow"} it)`);
  return { feature: key, want: on, live: r.live, site: await f.site(), pepe: r.pepe, act, chat: act ? null : f.chat[on ? 0 : 1] };
}

/** The old per-feature switch routes: after their own write, the same wish + audit row (they keep their own rules). */
async function noteLegacy(user, key, on) {
  try {
    if (!FEATURES[key] || !user || !user.userId) return;
    await init();
    const me = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [user.userId]).catch(() => []))[0] || user;
    const before = (await wants())[key] || null;
    const act = followsNow(await reader(), key);
    await putWant(key, !!on, me, "web-legacy", act);
    let live = null;
    try { live = !!(await FEATURES[key].live()); } catch (e) { live = null; }
    await audit(me, { feature: key, want: !!on, was: before ? before.want : null, live, via: "web-legacy", pepe_follows: act });
  } catch (e) { console.error("[backends] legacy note:", e && e.message); }
}

/** The shell's switch (tools/money-backend.js stashes on|off): the same wish (via "cli"), so /admin/backends never disagrees
 *  with the site switch after a shell change (review of the owner answers). The tool writes its own audit row. */
async function noteCli(key, on, actor) {
  if (!FEATURES[key]) return;
  await init();
  const act = followsNow(await reader(), key);
  await putWant(key, !!on, { username: String(actor || "?") + " (cli)", userId: null }, "cli", act);
}

/** Every row: the hand-overs (switchable) and the status-only cutovers. `me` (optional) adds can / why per row. */
async function view(me) {
  await init();
  const W = await wants();
  const rd = await reader();
  const SR = require("./staffroles");
  const owner = me ? !!(await SR.ownerOf(me, CAP).catch(() => null)) : false;
  const admin = !!(me && SP.can(me, CAP));
  const rows = [];
  for (const key of KEYS) {
    const f = FEATURES[key];
    let live = null, site = null, err = null;
    try { await f.prep(); live = !!(await f.live()); site = await f.site(); } catch (e) { err = String((e && e.message) || e).slice(0, 160); }
    const w = W[key] || null;
    const follows = followsNow(rd, key);
    rows.push({ key, owner: !!f.owner, live, site: site === null || site === undefined ? null : !!site, want: w ? w.want : null,
                by: w ? w.by : null, via: w ? w.via : null, at: w ? w.at : null, act: w ? w.act : false, pepe: w ? w.pepe : null,
                doc: f.doc ? DOCS + f.doc : null, error: err, can: admin && (!f.owner || owner),
                waiting: !!(w && live !== null && w.want !== live),
                // Pepe's part: does he follow this switch, and the chat command an owner runs while he doesn't
                follows, chat_on: f.chat[0], chat_off: f.chat[1],
                // a direction that would only record a wish is offered only while Pepe follows the switch
                offer_on: follows || (live !== null && !f.wishOnly(true, live)), offer_off: follows || (live !== null && !f.wishOnly(false, live)) });
  }
  const status = [];
  for (const [key, s] of Object.entries(STATUS_ONLY)) {
    let live = null, site = null, err = null;
    try { ({ live, site } = await s.state()); } catch (e) { err = String((e && e.message) || e).slice(0, 160); }
    status.push({ key, live, site, doc: DOCS + s.doc, error: err });
  }
  return { rows, status, owner, admin, reader: rd };
}

/** Pepe's read (bot token) and his report. b.follows: the hand-overs he runs from a wish; b.results: {key: {want, ok, msg}} -
 *  what he did for the CURRENT wish (a result for an older wish is ignored). -> the wish per hand-over + where it lives now;
 *  act: false = a wish made while he didn't follow it (he leaves it alone). want null = never switched here. */
async function botView(b = {}) {
  await init();
  if (Array.isArray(b.follows) || b.version !== undefined || (b.results && typeof b.results === "object")) await noteReader(b);
  const W = await wants();
  const features = {};
  for (const key of KEYS) {
    const f = FEATURES[key];
    let live = null, site = null;
    try { await f.prep(); live = !!(await f.live()); site = await f.site(); } catch (e) { live = null; }
    const w = W[key] || null;
    features[key] = { want: w ? w.want : null, act: !!(w && w.act), live, site: site === null || site === undefined ? null : !!site,
                      by: w ? w.by : null, at: w ? w.at : null };
  }
  return { ok: true, ts: clock(), contract: CONTRACT, features };
}
async function noteReader(b) {
  const follows = Array.isArray(b.follows) ? [...new Set(b.follows.map(String).filter((k) => KEYS.includes(k)))] : null;
  const ver = b.version === undefined || b.version === null ? null : String(b.version).slice(0, 40);
  const t = clock();
  if (follows) {
    await runQuery(`INSERT INTO backend_reader (id, at, version, follows) VALUES (1, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET at = excluded.at, version = excluded.version, follows = excluded.follows`, [t, ver, JSON.stringify(follows)]);
  }
  const res = b.results && typeof b.results === "object" && !Array.isArray(b.results) ? b.results : {};
  for (const [key, r] of Object.entries(res)) {
    if (!KEYS.includes(key) || !r || typeof r !== "object" || (r.want !== true && r.want !== false)) continue;
    const msg = String(r.msg == null ? "" : r.msg).replace(/[\u0000-\u001f]/g, " ").slice(0, 300) || null;
    await runQuery("UPDATE backend_wants SET pepe_at = ?, pepe_ok = ?, pepe_msg = ? WHERE feature = ? AND want = ?", [t, r.ok ? 1 : 0, msg, key, r.want ? 1 : 0]);
  }
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
    try { res.json(await botView(b)); } catch (e) { console.error("[backends] bot:", e); res.status(500).json({ ok: false, error: "server_error" }); }
  });
}

module.exports = { init, register, view, botView, reader, flip, mayFlip, noteLegacy, noteCli, wants, FEATURES, STATUS_ONLY, KEYS, CAP, CONTRACT,
                   READER_FRESH_MS, Refuse, _setClock: (fn) => { clock = fn || (() => Date.now()); } };
