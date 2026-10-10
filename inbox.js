// inbox.js — the on-site inbox (1.99au): one place for every system notice a user gets.
//
// Pepe's notices (staking/unstaking at the daily price, loans, wagers, markets, bounties, lotto wins,
// cosmetics gifts, prize-store purchases, ...) used to exist only as a Camfrog PM — and /msg only
// reaches someone in the room it's sent down, so anyone who wasn't in Pepe's room at that moment
// never saw them. Now every notice lands here too, and the site's own notices (shop order updates,
// tips received) as well.
//
//   inbox            id, user_id, kind, title, body, link, created (ms), read_at (ms), ref
//                    (ref = idempotency key: a retried push is stored once per user)
//   inbox_pending    notices for a Camfrog name with no PATV account yet; attached to the account
//                    when one is made or linked (attachPending — called from the Camfrog register /
//                    !verify paths and, as a safety net, when the inbox page is opened)
//   inbox_prefs      per user + category: pm_off = "don't PM me in Camfrog for this, inbox only"
//
// Routes
//   POST /api/inbox/push   bot token. {camfrog, kind, title, body, link, ref, created}
//                          -> {ok, stored: "user"|"pending", pm} (pm: may Pepe PM them for this kind)
//   GET  /inbox            301 -> /messages/notices, query string kept (1.99cu: notices are the pinned "🔔 Notices"
//                          item of the one /messages inbox, rendered by public/js/messages.js from feed() below)
//   GET  /api/inbox/notices  JSON: one page of notices (?kind= &page=) + per-category counts (same-site fetch only)
//   GET  /inbox/open/:id   mark one read and go to its link
//   POST /inbox/read       {id} or {all: 1}  (same-site form post; JSON answer for X-Requested-With: fetch)
//   POST /inbox/prefs      pm_<kind> checkboxes (form post)
//   POST /api/inbox/prefs  JSON {pm: {<kind>: true|false}} - only the kinds given change (the /messages ⚙ dialog)
// res.locals.inboxUnread (navCount middleware) feeds the 🔔 in the nav: one indexed COUNT per page view.
const jwt = require("jsonwebtoken");
const { runQuery, getQuery } = require("./dbUtils");

const KINDS = {
  staking:     { icon: "🏦", label: "Staking & vaults", link: "/staking" },
  loan:        { icon: "🏛️", label: "Loans", link: "/wallet" },
  wager:       { icon: "🤝", label: "Wagers", link: "/wagers" },
  market:      { icon: "🔮", label: "Markets & pools", link: "/markets" },
  bounty:      { icon: "🎯", label: "Bounties", link: "/bounties" },
  shop:        { icon: "🏪", label: "Shop", link: "/shop/orders" },
  cosmetics:   { icon: "🎨", label: "Cosmetics", link: "/cosmetics" },
  lotto:       { icon: "🎟️", label: "Lotto", link: "/lotto" },
  tip:         { icon: "💸", label: "Tips", link: "/history" },
  achievement: { icon: "🏅", label: "Achievements", link: "/achievements" },
  stage:       { icon: "📺", label: "Stage & streaming", link: "/stage" },
  media:       { icon: "🎬", label: "Movie & show requests, Plex invites", link: "/requests" },   // 1.99ji: mediarequests.js / mediainvites.js
  room:        { icon: "🏠", label: "Your pads", link: "/p" },
  feed:        { icon: "📝", label: "Feed posts & comments", link: "/feed" },
  follow:      { icon: "⭐", label: "New posts from people & pads you follow", link: "/feed/following" },
  dm:          { icon: "💬", label: "Direct messages (a Camfrog alert from Pepe)", link: "/messages" },   // 1.99cp: messages.js; never filed here
  mention:     { icon: "📣", label: "Room mentions (your name or words in a Camfrog room)", link: "/settings/mentions" },   // 1.99ii: mentions.js; site-only
  admin:       { icon: "🛠️", label: "Admin", link: null },
  system:      { icon: "🐸", label: "Pepe", link: null },
};
const NOTICES = "/messages/notices";  // where the notices are shown (the 🔔 Notices item of /messages)
const PAGE = 25;
const KEEP_PER_USER = 1000;          // oldest beyond this are pruned
const PENDING_KEEP_MS = 30 * 86400000;

const ready = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT, link TEXT, created INTEGER NOT NULL, read_at INTEGER, ref TEXT)`);
  await runQuery("CREATE INDEX IF NOT EXISTS inbox_user ON inbox (user_id, id)");
  await runQuery("CREATE INDEX IF NOT EXISTS inbox_unread ON inbox (user_id, read_at)");
  await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS inbox_ref ON inbox (user_id, ref)");
  await runQuery(`CREATE TABLE IF NOT EXISTS inbox_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT, camfrog TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT, link TEXT, created INTEGER NOT NULL, ref TEXT)`);
  await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS inbox_pending_ref ON inbox_pending (camfrog, ref)");
  await runQuery(`CREATE TABLE IF NOT EXISTS inbox_prefs (
    user_id TEXT NOT NULL, kind TEXT NOT NULL, pm_off INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, kind))`);
})().catch((e) => console.error("[inbox] setup:", e.message));

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, n);
const kindOf = (k) => (Object.prototype.hasOwnProperty.call(KINDS, k) ? k : "system");
const camOf = (s) => String(s || "").trim().replace(/^@/, "").toLowerCase();

/** A link we'll put in an <a href>: a local path only ("/x", never "//host", "/\host" or a scheme). */
function safeLink(l) {
  const s = String(l || "").trim();
  if (!s || s.length > 300 || s[0] !== "/" || s[1] === "/" || s[1] === "\\") return null;
  if (/[\s\\\u0000-\u001f\u007f"'<>]/.test(s)) return null;
  return s;
}

function titleFrom(body) {
  const t = clean(body, 400).replace(/\s+/g, " ");
  return t.length > 90 ? t.slice(0, 89).trimEnd() + "…" : t;
}

function norm(n) {
  const kind = kindOf(n.kind);
  const body = clean(n.body, 2000);
  const title = clean(n.title, 160) || titleFrom(body) || KINDS[kind].label;
  const created = Number(n.created) > 1e12 && Number(n.created) < Date.now() + 60000 ? Math.floor(Number(n.created)) : Date.now();
  return { kind, title, body: body === title ? "" : body, link: safeLink(n.link) || KINDS[kind].link || null,
           ref: clean(n.ref, 120) || null, created };
}

/** File one notice for a PATV account. Returns true if stored (false = duplicate ref). */
async function add(userId, n) {
  if (!userId) return false;
  await ready;
  const x = norm(n || {});
  const r = await runQuery(`INSERT OR IGNORE INTO inbox (user_id, kind, title, body, link, created, ref) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, x.kind, x.title, x.body || null, x.link, x.created, x.ref]);
  const stored = !!(r && r.changes);
  if (stored && Math.random() < 0.05) {
    runQuery(`DELETE FROM inbox WHERE user_id = ? AND id NOT IN (SELECT id FROM inbox WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
      [userId, userId, KEEP_PER_USER]).catch(() => {});
  }
  return stored;
}

/** Same, never throws (for side notices like "tip received" that must not break the real work). */
async function addSafe(userId, n) {
  try { return await add(userId, n); } catch (e) { console.error("[inbox] add:", e.message); return false; }
}

async function userForCamfrog(camfrog) {
  const rows = await getQuery("SELECT userId FROM users WHERE LOWER(camfrogUsername) = LOWER(?) LIMIT 1", [camfrog]);
  return rows.length ? rows[0].userId : null;
}

/** A notice for a Camfrog name: its account's inbox, or pending until one is linked. */
async function addForCamfrog(camfrog, n) {
  await ready;
  const cf = camOf(camfrog);
  if (!cf) return { stored: null };
  const userId = await userForCamfrog(cf);
  if (userId) {
    const stored = await add(userId, n);
    return { stored: "user", userId, dup: !stored };
  }
  const x = norm(n || {});
  const r = await runQuery(`INSERT OR IGNORE INTO inbox_pending (camfrog, kind, title, body, link, created, ref) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [cf, x.kind, x.title, x.body || null, x.link, x.created, x.ref]);
  runQuery("DELETE FROM inbox_pending WHERE created < ?", [Date.now() - PENDING_KEEP_MS]).catch(() => {});
  return { stored: "pending", dup: !(r && r.changes) };
}

/** Move pending notices for `camfrog` into `userId`'s inbox (on account creation / Camfrog link). */
async function attachPending(userId, camfrog) {
  const cf = camOf(camfrog);
  if (!userId || !cf) return 0;
  await ready;
  const rows = await getQuery("SELECT * FROM inbox_pending WHERE camfrog = ? ORDER BY id", [cf]);
  let n = 0;
  for (const p of rows) {
    const r = await runQuery(`INSERT OR IGNORE INTO inbox (user_id, kind, title, body, link, created, ref) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, p.kind, p.title, p.body, p.link, p.created, p.ref]);
    if (r && r.changes) n++;
    await runQuery("DELETE FROM inbox_pending WHERE id = ?", [p.id]);
  }
  if (n) console.log(`[inbox] attached ${n} pending notice(s) for ${cf} to ${userId}`);
  return n;
}

async function attachPendingSafe(userId, camfrog) {
  try { return await attachPending(userId, camfrog); } catch (e) { console.error("[inbox] attach:", e.message); return 0; }
}

async function prefs(userId) {
  await ready;
  const out = {};
  for (const k of Object.keys(KINDS)) out[k] = { pm: true };
  if (!userId) return out;
  for (const r of await getQuery("SELECT kind, pm_off FROM inbox_prefs WHERE user_id = ?", [userId])) {
    if (out[r.kind]) out[r.kind].pm = !r.pm_off;
  }
  return out;
}

/** May Pepe PM this user in Camfrog for this category? (Inbox prefs; default yes.) */
async function pmAllowed(userId, kind) {
  if (!userId) return true;
  await ready;
  const r = await getQuery("SELECT pm_off FROM inbox_prefs WHERE user_id = ? AND kind = ?", [userId, kindOf(kind)]);
  return !(r[0] && r[0].pm_off);
}

async function unreadCount(userId) {
  if (!userId) return 0;
  await ready;
  const r = await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND read_at IS NULL", [userId]);
  return r[0] ? r[0].n : 0;
}

async function list(userId, { page = 1, kind = null } = {}) {
  await ready;
  const k = kind && KINDS[kind] ? kind : null;
  const where = "user_id = ?" + (k ? " AND kind = ?" : "");
  const args = k ? [userId, k] : [userId];
  const total = (await getQuery(`SELECT COUNT(*) AS n FROM inbox WHERE ${where}`, args))[0].n;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const rows = await getQuery(`SELECT id, kind, title, body, link, created, read_at FROM inbox WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...args, PAGE, (p - 1) * PAGE]);
  const counts = await getQuery("SELECT kind, COUNT(*) AS n, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM inbox WHERE user_id = ? GROUP BY kind", [userId]);
  return { rows, total, page: p, pages, kind: k, counts };
}

/** Categories for the page, in display order: [{key, icon, label}]. */
function kindList() {
  return Object.keys(KINDS).map((k) => ({ key: k, icon: KINDS[k].icon, label: KINDS[k].label }));
}

/** Everything the Notices pane needs, as JSON (plain text only - the page puts it in with textContent). */
async function feed(userId, { page = 1, kind = null } = {}) {
  const L = await list(userId, { page, kind });
  return {
    items: L.rows.map((n) => ({ id: n.id, kind: kindOf(n.kind), title: n.title, body: n.body || "", link: !!safeLink(n.link),
                                created: n.created, unread: !n.read_at })),
    page: L.page, pages: L.pages, total: L.total, kind: L.kind,
    counts: L.counts.map((c) => ({ kind: c.kind, n: c.n, unread: c.unread || 0 })),
    unread: await unreadCount(userId), latest: await latest(userId),
  };
}

/** The newest notice ({title, created}) or null - the pinned 🔔 Notices item's preview line. */
async function latest(userId) {
  if (!userId) return null;
  await ready;
  return (await getQuery("SELECT title, created FROM inbox WHERE user_id = ? ORDER BY id DESC LIMIT 1", [userId]))[0] || null;
}

/** Set the Camfrog-PM switch for the given categories only ({kind: true = PM me}). Unknown kinds are ignored. */
async function setPrefs(userId, pm) {
  await ready;
  for (const k of Object.keys(pm || {})) {
    if (!Object.prototype.hasOwnProperty.call(KINDS, k)) continue;
    await runQuery(`INSERT INTO inbox_prefs (user_id, kind, pm_off) VALUES (?, ?, ?)
                    ON CONFLICT(user_id, kind) DO UPDATE SET pm_off = excluded.pm_off`, [userId, k, pm[k] ? 0 : 1]);
  }
  return prefs(userId);
}

/** Mark one (id) or all read — only the owner's rows. Returns rows changed. */
async function markRead(userId, id) {
  await ready;
  const now = Date.now();
  const r = id === "all"
    ? await runQuery("UPDATE inbox SET read_at = ? WHERE user_id = ? AND read_at IS NULL", [now, userId])
    : await runQuery("UPDATE inbox SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL", [now, userId, parseInt(id, 10) || 0]);
  return (r && r.changes) || 0;
}

async function getOwn(userId, id) {
  await ready;
  const r = await getQuery("SELECT * FROM inbox WHERE id = ? AND user_id = ?", [parseInt(id, 10) || 0, userId]);
  return r[0] || null;
}

/** Middleware: res.locals.inboxUnread for HTML page views by a signed-in user (the nav 🔔). */
function navCount(req, res, next) {
  if (req.method !== "GET" || /^\/(api|public|og|uploads)\b|^\/healthz/.test(req.path)) return next();
  const token = req.cookies && req.cookies.jwt;
  if (!token || !process.env.SECRET_KEY) return next();
  let d = null;
  try { d = jwt.verify(token, process.env.SECRET_KEY); } catch (e) { d = null; }
  if (!d || !d.userId) return next();
  unreadCount(d.userId).then((n) => { res.locals.inboxUnread = n; }, () => {}).then(() => next());
}

function sameSite(req) {
  const host = req.get("host");
  const src = req.get("origin") || req.get("referer");
  if (!src || !host) return true;            // browsers that send neither (SameSite=Lax cookie still applies)
  try { return new URL(src).host === host; } catch (e) { return false; }
}

function register(app, { isBotToken, addUser }) {
  // Pepe files a notice for a Camfrog name.
  app.post("/api/inbox/push", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    const cf = camOf(b.camfrog);
    if (!/^[a-z0-9_.\-]{1,40}$/i.test(cf)) return res.status(400).json({ ok: false, error: "bad camfrog name" });
    if (!clean(b.body, 2000) && !clean(b.title, 160)) return res.status(400).json({ ok: false, error: "empty notice" });
    try {
      const r = await addForCamfrog(cf, b);
      const pm = r.userId ? await pmAllowed(r.userId, b.kind) : true;
      res.json({ ok: true, stored: r.stored, dup: !!r.dup, pm });
    } catch (e) {
      console.error("[inbox] push:", e.message);
      res.status(500).json({ ok: false, error: "internal error" });
    }
  });

  // 1.99cu: the notices are a pane of /messages now. Old links (nav bookmarks, Pepe's PMs, emails) keep working.
  app.get("/inbox", (req, res) => {
    const q = req.originalUrl.indexOf("?");
    res.redirect(301, NOTICES + (q >= 0 ? req.originalUrl.slice(q) : ""));
  });

  // one page of notices for the Notices pane (same-site fetch only, like the /api/messages calls)
  app.get("/api/inbox/notices", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!sameSite(req) || req.get("x-requested-with") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      res.json({ ok: true, ...(await feed(req.user.userId, { page: req.query.page, kind: String(req.query.kind || "") || null })) });
    } catch (e) {
      console.error("[inbox] notices:", e.message);
      res.status(500).json({ ok: false, error: "Couldn't load your notices." });
    }
  });

  // open a notice: mark it read, then follow its link (only ever a local path)
  app.get("/inbox/open/:id", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent(NOTICES));
    const n = await getOwn(req.user.userId, req.params.id).catch(() => null);
    if (!n) return res.redirect(NOTICES);
    await markRead(req.user.userId, n.id).catch(() => {});
    res.redirect(safeLink(n.link) || NOTICES);
  });

  const back = (b) => {
    const s = String(b || "").replace(/^\/inbox(?=\?|$)/, NOTICES);
    return /^\/messages\/notices(\?[A-Za-z0-9=&_%-]*)?$/.test(s) ? s : NOTICES;
  };
  app.post("/inbox/read", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent(NOTICES));
    if (!sameSite(req)) return res.status(403).send("Cross-site request refused");
    const b = req.body || {};
    const n = await markRead(req.user.userId, b.all ? "all" : b.id).catch(() => 0);
    if (req.get("x-requested-with") === "fetch") return res.json({ ok: true, changed: n, unread: await unreadCount(req.user.userId) });
    res.redirect(back(b.back));
  });

  app.post("/inbox/prefs", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent(NOTICES));
    if (!sameSite(req)) return res.status(403).send("Cross-site request refused");
    const b = req.body || {};
    try {
      const pm = {};
      for (const k of Object.keys(KINDS)) pm[k] = !!b["pm_" + k];
      await setPrefs(req.user.userId, pm);
      res.redirect(NOTICES + "?msg=" + encodeURIComponent("Saved — Pepe will only PM you in Camfrog for the ticked categories."));
    } catch (e) {
      console.error("[inbox] prefs:", e.message);
      res.redirect(NOTICES + "?msg=" + encodeURIComponent("Couldn't save that — try again."));
    }
  });

  // the /messages ⚙ dialog: JSON, only the categories it sends change
  app.post("/api/inbox/prefs", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!sameSite(req) || req.get("x-requested-with") !== "fetch" || !req.is("application/json")) return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const pm = req.body && req.body.pm;
    if (!pm || typeof pm !== "object" || Array.isArray(pm)) return res.status(400).json({ ok: false, error: "Nothing to save." });
    try {
      res.json({ ok: true, prefs: await setPrefs(req.user.userId, pm) });
    } catch (e) {
      console.error("[inbox] prefs:", e.message);
      res.status(500).json({ ok: false, error: "Couldn't save that - try again." });
    }
  });
}

module.exports = { register, add, addSafe, addForCamfrog, attachPending, attachPendingSafe, pmAllowed, prefs, setPrefs,
                   unreadCount, list, feed, latest, kindList, markRead, navCount, safeLink, KINDS, NOTICES, ready };
