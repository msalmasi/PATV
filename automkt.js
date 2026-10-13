// automkt.js — 1.99th: Pepe's auto markets on the site (camfrog-bot pepe_automkt.py makes them; this is the admin side + the feed).
//
// Pepe pushes his status every minute (settings, this week's count, the review queue, the auto-created list with each one's
// resolution state, the preview, the sources) and pulls the admins' requests from here - outbound only, like the control panel.
//   POST /api/automkt/sync      (bot)  {status} -> {ok, requests: [{id, action, args, by}]}   (handed out once; re-offered after 5 min)
//   POST /api/automkt/ack       (bot)  {id, ok, message, extra}
//   POST /api/automkt/announce  (bot)  {items: [{ref, id, question, options, closes, cat, tag, model}]} (1.99vc: or a poll
//                                      {kind: "poll", poll_id, ...} -> links /polls/<id>) -> a feed post as Pepe in
//                                      ONE pad (1.99wq, pepetopics.js: the best fit for the questions, else `pad` - the auto
//                                      pad Pepe sends - else Pepe's Pad; was always the Camfrog Lounge), never the same batch
//                                      twice in 48 h, flaired + tagged from that pad's own (pepelabels.js kind "markets"),
//                                      rate-limited here (FEED_GAP_MS, FEED_PER_DAY) whatever Pepe sends
//   GET  /admin/markets         the admin page (views/admin/markets.ejs + public/js/admin-automkt.js)
//   GET  /api/admin/automkt     (admins) {state, requests}
//   POST /api/admin/automkt     (admins, same-site JSON) {action: set|generate|preview|approve|reject, args} -> queued for Pepe
// The markets themselves are ordinary markets / pools with an `auto` record (markets.cleanAuto) - /markets shows the 🤖 auto tag.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const ACTIONS = new Set(["set", "generate", "preview", "approve", "reject"]);
const FEED_GAP_MS = 6 * 3600e3;          // at most one auto-market feed post every 6 h ...
const FEED_PER_DAY = 3;                  // ... and 3 a day
const RECLAIM_MS = 5 * 60e3;
const CATS = ["sports", "prices", "news", "trending"];   // 1.99vc: trending = Polymarket topics as ideas (Pepe's own wording), off by default
const POLL_ID = /^[A-Za-z0-9_-]{1,64}$/;
let clock = () => Date.now();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS automkt_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL)");
      await runQuery(`CREATE TABLE IF NOT EXISTS automkt_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL,
        action TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', claimed INTEGER, done_at INTEGER, ok INTEGER, message TEXT, extra TEXT)`);
      await runQuery("CREATE TABLE IF NOT EXISTS automkt_feed (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, post_id TEXT, refs TEXT, skipped TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }
const parse = (s, d = null) => { try { return JSON.parse(s); } catch (e) { return d; } };

// ── Pepe's side ──
async function sync(body) {
  await init();
  const st = body && typeof body.status === "object" && body.status ? body.status : null;
  if (st) {
    const data = JSON.stringify(st);
    if (data.length > 400000) throw new Refuse(413, "status too large");
    await runQuery(`INSERT INTO automkt_state (id, data, at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, at = excluded.at`, [data, clock()]);
  }
  const now = clock();
  const rows = await getQuery(`SELECT id, by, action, args FROM automkt_requests WHERE status = 'pending' OR (status = 'claimed' AND claimed < ?)
                               ORDER BY id LIMIT 5`, [now - RECLAIM_MS]);
  for (const r of rows) await runQuery("UPDATE automkt_requests SET status = 'claimed', claimed = ? WHERE id = ?", [now, r.id]);
  return { ok: true, requests: rows.map((r) => ({ id: r.id, by: r.by, action: r.action, args: parse(r.args, {}) })) };
}

async function ack(body) {
  await init();
  const id = Math.floor(Number(body && body.id));
  if (!(id > 0)) throw new Refuse(400, "bad id");
  let extra = "{}";
  try { extra = JSON.stringify(body.extra || {}).slice(0, 60000); } catch (e) { extra = "{}"; }
  await runQuery(`UPDATE automkt_requests SET status = 'done', done_at = ?, ok = ?, message = ?, extra = ? WHERE id = ? AND status != 'done'`,
                 [clock(), body.ok ? 1 : 0, String(body.message || "").slice(0, 300), extra, id]);
  return { ok: true };
}

/** The 🤖 auto-markets feed post (one for a batch). Rate-limited here whatever Pepe sends. */
async function announce(body) {
  await init();
  // 1.99vc: an auto POLL ({kind: "poll", poll_id}) links /polls/<id>; markets and pools /markets/<id>
  const isPoll = (x) => x && x.kind === "poll" && POLL_ID.test(String(x.poll_id || ""));
  const items = (Array.isArray(body && body.items) ? body.items : []).slice(0, 6).filter((x) => x && x.question && (isPoll(x) || Number(x.id) > 0));
  if (!items.length) throw new Refuse(400, "nothing to announce");
  const now = clock();
  const recent = await getQuery("SELECT at FROM automkt_feed WHERE post_id IS NOT NULL AND at > ? ORDER BY at DESC", [now - 86400e3]);
  const refOf = (x) => (isPoll(x) ? `P:${x.poll_id}` : `M${Math.floor(Number(x.id))}`);
  const refs = JSON.stringify(items.map(refOf));
  const skip = async (why) => { await runQuery("INSERT INTO automkt_feed (at, post_id, refs, skipped) VALUES (?, NULL, ?, ?)", [now, refs, why]); return { ok: true, posted: false, skipped: why }; };
  if (recent.length >= FEED_PER_DAY) return skip("daily cap");
  if (recent.length && now - recent[0].at < FEED_GAP_MS) return skip("too soon after the last one");
  const I = require("./i18n");
  const t = I.tFor("en");
  const pf = require("./pepefeed");
  const store = require("./feedstore");
  const rooms = require("./rooms");
  const acct = await pf.ensureAccount();
  const CAT = { sports: "🏟️", prices: "📈", news: "📰", trending: "🔥" };
  const when = (s) => new Date(Number(s) * 1000).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
  const title = items.length === 1 ? t("automkt.feed.title_one", { q: String(items[0].question).slice(0, 120) })
                                   : t("automkt.feed.title_many", { n: items.length });
  const lines = items.map((x) => (isPoll(x)
    ? t("automkt.feed.line_poll", { ic: "📊", q: String(x.question).slice(0, 200), opts: (x.options || []).map(String).join(" / ").slice(0, 120),
                                    closes: when(x.closes), link: `/polls/${encodeURIComponent(String(x.poll_id))}` })
    : t("automkt.feed.line", { ic: CAT[x.cat] || "🔮", ref: `M${Math.floor(Number(x.id))}`, q: String(x.question).slice(0, 200),
                               opts: (x.options || []).map(String).join(" / ").slice(0, 120), closes: when(x.closes),
                               link: `/markets/${Math.floor(Number(x.id))}` })));
  const text = [t("automkt.feed.intro"), "", ...lines, "", t("automkt.feed.foot")].join("\n");
  // 1.99wq: one story, one pad (pepetopics.js) + his flair / tags there (pepelabels.js)
  const TP = require("./pepetopics");
  const topic = { kind: "markets", key: "mkt:" + JSON.parse(refs).slice().sort().join(","), story: { headline: items.map((x) => String(x.question)).join(" ").slice(0, 600) }, title };
  const dup = await TP.duplicate(topic).catch(() => null);
  if (dup) return skip("already announced (" + dup.why + ")");
  let fallback = rooms.HOUSE_ROOM;
  if (typeof body.pad === "string" && body.pad.trim()) { const R0 = await require("./feedstore").communityOf(body.pad.trim()).catch(() => null); if (R0 && !R0.profile) fallback = R0.id; }
  const to = await TP.route({ ...topic, fallback, force: true }).catch(() => ({ room: fallback }));
  const home = to.room || fallback;
  const L = await require("./pepelabels").pick({ roomId: home, kind: "markets", title, body: text }).catch(() => ({ flair: null, tags: [] }));
  const p = await store.create(acct.userId, { title: title.slice(0, store.TITLE_MAX || 200), body: text.slice(0, 3000), community: home, nsfw: false, announce: [],
                                              tags: L.tags, flair: L.flair ? L.flair.id : "" }, {});
  await TP.remember({ ...topic, room: home, post: p.id }).catch(() => {});
  try { await require("./contentaudit").record({ via: "bot", bot: true }, { kind: "post", id: p.id, postId: p.id, event: "create", user: await store.account(acct.userId) }); } catch (e) { /* audit is best effort here */ }
  await runQuery("INSERT INTO automkt_feed (at, post_id, refs, skipped) VALUES (?, ?, ?, NULL)", [now, String(p.id), refs]);
  return { ok: true, posted: true, id: p.id, url: p.url };
}

// ── the admins' side ──
async function adminState() {
  await init();
  const row = (await getQuery("SELECT data, at FROM automkt_state WHERE id = 1"))[0];
  const reqs = await getQuery("SELECT id, at, by, action, args, status, done_at, ok, message, extra FROM automkt_requests ORDER BY id DESC LIMIT 20");
  const feed = await getQuery("SELECT at, post_id, refs, skipped FROM automkt_feed ORDER BY id DESC LIMIT 10");
  return { state: row ? parse(row.data, null) : null, at: row ? row.at : null, online: !!row && clock() - row.at < 3 * 60e3,
           requests: reqs.map((r) => ({ ...r, args: parse(r.args, {}), extra: parse(r.extra, null) })), feed };
}

/** Queue a request for Pepe. Settings are validated again by Pepe (pepe_automkt.clean_cfg). */
async function request(me, b) {
  await init();
  const action = String((b && b.action) || "");
  if (!ACTIONS.has(action)) throw new Refuse(400, "Unknown action.");
  const a = b.args && typeof b.args === "object" ? b.args : {};
  let args = {};
  if (action === "set") {
    const c = a.cfg && typeof a.cfg === "object" ? a.cfg : {};
    const cfg = {};
    if ("enabled" in c) cfg.enabled = !!c.enabled;
    for (const k of ["per_week", "announce_gap_min", "seed_cap_week", "poly_every_h", "poll_hours"]) if (c[k] !== undefined && Number.isFinite(Number(c[k]))) cfg[k] = Math.max(0, Math.floor(Number(c[k])));
    if (["news", "all", "none"].includes(c.review)) cfg.review = c.review;
    if (c.cats && typeof c.cats === "object") cfg.cats = Object.fromEntries(CATS.filter((k) => k in c.cats).map((k) => [k, !!c.cats[k]]));
    for (const k of ["announce", "feed_post", "polls", "marquee_only"]) if (k in c) cfg[k] = !!c[k];
    // 1.99wd: the category weights (0..10, 0 = never) and the pad auto markets / pools / polls go to ("" = Pepe's Pad)
    if (c.weights && typeof c.weights === "object") {
      cfg.weights = Object.fromEntries(CATS.filter((k) => k in c.weights && Number.isFinite(Number(c.weights[k])))
        .map((k) => [k, Math.max(0, Math.min(10, Number(c.weights[k])))]));
    }
    if (typeof c.pad === "string" && /^[A-Za-z0-9._:~\-]{0,128}$/.test(c.pad.trim())) cfg.pad = c.pad.trim();
    for (const k of ["leagues", "assets", "feeds"]) if (Array.isArray(c[k])) cfg[k] = c[k].map((x) => String(x).slice(0, 20)).slice(0, 20);
    if (!Object.keys(cfg).length) throw new Refuse(400, "Nothing to change.");
    args = { cfg };
  } else if (action === "generate" || action === "preview") {
    args = { n: Math.max(1, Math.min(10, Math.floor(Number(a.n) || (action === "preview" ? 3 : 1)))) };
    if (action === "generate") args.force = true;
  } else {
    const id = String(a.id || "").trim();
    if (!/^[a-z]\d{1,8}$/i.test(id)) throw new Refuse(400, "Which item?");
    args = { id, why: String(a.why || "").slice(0, 160) };
  }
  const open = await getQuery("SELECT COUNT(*) AS n FROM automkt_requests WHERE status IN ('pending','claimed')");
  if (open[0].n >= 10) throw new Refuse(429, "Pepe has 10 requests waiting already - give him a minute.");
  const r = await runQuery("INSERT INTO automkt_requests (at, by, action, args) VALUES (?, ?, ?, ?)", [clock(), String(me.username).slice(0, 60), action, JSON.stringify(args)]);
  return { id: r && (r.id || r.lastID) };
}

async function isAdminNow(req) {
  if (!req.user || !req.user.userId) return null;
  const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
  return u && u.class === "Admin" ? { userId: u.userId, username: u.username } : null;
}

function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[automkt] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
      console.error("[automkt]", req.path, e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  const bigJson = require("express").json({ limit: "1mb" });     // the status carries the auto-created list
  app.post("/api/automkt/sync", bigJson, bot(sync));
  app.post("/api/automkt/ack", bot(ack));
  app.post("/api/automkt/announce", bot(announce));

  const guard = require("./middleware/authGuard");
  app.get("/api/admin/automkt", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const me = await isAdminNow(req).catch(() => null);
    if (!me) return res.status(403).json({ ok: false, error: "Admins only." });
    try { res.json({ ok: true, ...(await adminState()) }); } catch (e) { console.error("[automkt] admin:", e); res.status(500).json({ ok: false, error: "Couldn't load." }); }
  });
  app.post("/api/admin/automkt", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const me = await isAdminNow(req).catch(() => null);
    if (!me) return res.status(403).json({ ok: false, error: "Admins only." });
    if (!guard.sameSite(req) || !req.is("application/json")) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    try { res.json({ ok: true, ...(await request(me, req.body || {})), ...(await adminState()) }); } catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
      console.error("[automkt] request:", e);
      res.status(500).json({ ok: false, error: "Something went wrong - nothing was queued." });
    }
  });
  app.get("/admin/markets", addUser, async (req, res) => {
    const me = await isAdminNow(req).catch(() => null);
    if (!me) { if (typeof req.flash === "function") req.flash("error", "Admins only."); return res.redirect("/login"); }
    try {
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      res.render("admin/markets", { user: me.username, title: "Admin · Auto markets", section: "markets", isAdmin: true, errors: [], success: [], A: await adminState() });
    } catch (e) { console.error("[automkt] page:", e); res.status(500).send("Couldn't load the auto markets."); }
  });
}

module.exports = { init, register, sync, ack, announce, adminState, request, Refuse, FEED_GAP_MS, FEED_PER_DAY,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
