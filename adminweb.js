// adminweb.js — the admin area (1.99cv): /admin (Overview) + its section pages, all inside one shell
// (views/partials/admin-open.ejs / admin-close.ejs, sidebar in views/partials/admin-nav.ejs).
//
//   /admin              Overview: Pepe, Reserve, reports, loan requests, stage, stale cleanup, alerts
//   /admin/users        roles + classes, XP, welcome bonus, stale-account cleanup
//   /admin/economy      Reserve + today's flows, loans/credit, PAT grants, redemption codes, royalties, shop
//   /admin/games        manual wheel spin, jackpot top-up, casino bans (where they live)
//   /admin/cosmetics    badges (create / list / delete), links to cosmetics + achievements
//   /admin/bridge       the web command audit log (GET /api/bridge/cmdlog, admins only)
//   /admin/pepe         the Pepe control panel (views/partials/pepe-control.ejs) + where his feed settings live
//   /admin/system       site health: version, uptime, database, disk
//   /feed/admin, /pads/admin, /stage/admin render in the same shell (their own routes and gates).
//
// Every page here has the gate the old /admin/panel had: a signed-in Admin or Staff (req.user.class), else a
// flash + redirect to /login. Admin-only data (Pepe, Reserve, loans, stale cleanup, DM reports) is only read
// for an account whose class in the DATABASE is Admin, like the APIs behind those cards check.
// Old URLs: /admin/panel (and its #welcome-admin / #stale-admin anchors) -> /admin, which forwards the anchors.
"use strict";
const { execFileSync } = require("child_process");
const { getQuery } = require("./dbUtils");

const SECTION_VIEWS = {
  users: "Users & Accounts",
  economy: "Economy",
  games: "Games",
  cosmetics: "Cosmetics & Achievements",
  bridge: "Bridge",
  pepe: "Pepe",
  system: "System",
};

let siteSha = null;
function sha() {
  if (siteSha !== null) return siteSha;
  try { siteSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: __dirname, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch (e) { siteSha = ""; }
  return siteSha;
}

const isStaffClass = (c) => c === "Admin" || c === "Staff";
const safe = async (fn, dflt = null) => { try { return await fn(); } catch (e) { return dflt; } };
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

/** The signed-in account as the database has it now (the JWT's class can be stale). */
async function freshMe(req) {
  if (!req.user || !req.user.userId) return null;
  return (await safe(() => getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]), []))[0] || null;
}

// ── Overview data. Each source is independent: one failing shows as "unknown", never breaks the page. ──
async function pepeStatus() {
  const r = (await getQuery("SELECT at, data FROM pepe_control_status WHERE id = 1"))[0];
  if (!r) return { known: false };
  const s = parse(r.data) || {};
  const p = s.pepe || {};
  return { known: true, online: Date.now() - r.at < 60 * 1000, at: r.at, running: !!p.running, hung: !!p.hung,
           version: s.version || null, sha: s.sha ? String(s.sha).slice(0, 7) : null, env: s.env || null };
}
async function reserveStatus() {
  const funding = require("./funding");
  const today = await getQuery(`SELECT flow, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t FROM reserve_claims
                                WHERE created >= date('now') GROUP BY flow ORDER BY t DESC`);
  const uns = (await getQuery(`SELECT COALESCE(SUM(amount), 0) AS t FROM reserve_claims
                               WHERE settled = 0 AND COALESCE(queued, 0) = 0 AND flow NOT LIKE 'incentives:%'`))[0].t;
  const jp = await safe(async () => (await getQuery("SELECT COALESCE(SUM(amount), 0) AS t FROM jackpot_rakes"))[0].t, null);
  return { balance: funding.state.reserve, syncedAt: funding.state.syncedAt || 0, today, todayTotal: today.reduce((a, r) => a + (r.t || 0), 0),
           unsettled: uns, jackpot: jp };
}
// economy v2 E-2: the incentive budget Pepe syncs + the website's queue of grants waiting for it
async function incentiveStatus() {
  return require("./funding").queueSummary(25);
}
async function loanStatus() {
  const r = (await getQuery("SELECT data, updated FROM wallet_snapshots WHERE key = 'loans'"))[0];
  if (!r) return { known: false };
  const d = parse(r.data) || {};
  const pending = (d.requests || []).filter((x) => x.status === "pending" || x.status === "approving");
  const OPEN = new Set(["offered", "accepting", "funding", "active"]);
  const reserveOpen = (d.loans || []).filter((l) => l.reserve && OPEN.has(l.status));
  return { known: true, pending: pending.length, oldest: pending.reduce((m, x) => Math.min(m, x.created || Infinity), Infinity),
           reserveOpen: reserveOpen.length, book: d.reserve ? d.reserve.book : null, room: d.reserve ? d.reserve.room : null,
           enabled: d.reserve ? !!d.reserve.enabled : null, updated: r.updated };
}
async function reportStatus(isAdmin) {
  const store = require("./feedstore");
  const posts = await store.reports();
  const users = await store.userReports();
  const dms = isAdmin ? await safe(() => require("./messages").reportQueue(), []) : null;
  return { posts: posts.length, postsUrgent: posts.filter((x) => x.urgent).length, users: users.length, usersUrgent: users.filter((x) => x.urgent).length,
           dms: dms ? dms.length : null, dmsUrgent: dms ? dms.filter((x) => x.urgent).length : null };
}
async function stageStatus() {
  const ms = require("./mainstage");
  const st = await safe(() => require("./bridge").stage(), null);
  const open = await safe(() => ms.openSlots(), []);
  const next = await safe(() => ms.futureSlots(), []);
  return { pepeLive: st ? !!st.active : null, since: st ? st.since : null, known: st ? !!st.known : false, userLive: open.length,
           upcoming: next.length, nextAt: next.length ? next[0].start_at : null };
}
async function staleStatus() {
  const s = await require("./staleaccounts").noticeSummary();
  if (!s || !s.meta) return { started: false };
  const pend = (s.rows || []).filter((r) => r.state === "pending");
  return { started: true, applyOn: s.meta.apply_on, purgeOn: s.meta.purge_on, runId: s.meta.run_id,
           pending: pend.reduce((a, r) => a + r.n, 0), pendingPat: pend.reduce((a, r) => a + r.pat, 0),
           archived: s.archived ? s.archived.n : 0 };
}
async function shopStatus() {
  const review = (await getQuery("SELECT COUNT(*) AS n FROM prizes WHERE status = 'pending_review'"))[0].n;
  const disputes = await safe(async () => (await getQuery("SELECT COUNT(*) AS n FROM shop_orders WHERE status = 'disputed'"))[0].n, 0);
  return { review, disputes };
}
function diskStatus() {
  const store = require("./feedstore");
  const free = require("./feedmedia").diskFreeBytes();
  const min = Number(store.config().min_free_gb) || 0;
  return { free: free === Infinity ? null : free, minFreeGb: min };
}

const daysUntil = (ymd) => {
  const t = Date.parse(String(ymd || "") + "T00:00:00Z");
  return isFinite(t) ? Math.ceil((t - Date.now()) / 86400000) : null;
};

async function overview(me) {
  const isAdmin = !!me && me.class === "Admin";
  const [reports, stage, shop] = await Promise.all([safe(() => reportStatus(isAdmin)), safe(stageStatus), safe(shopStatus)]);
  const [pepe, reserve, loans, stale] = isAdmin
    ? await Promise.all([safe(pepeStatus), safe(reserveStatus), safe(loanStatus), safe(staleStatus)])
    : [null, null, null, null];
  const disk = await safe(async () => diskStatus());
  const terms = await safe(async () => require("./terms").enforced(), null);

  // alerts: the things worth acting on now, most urgent first
  const alerts = [];
  const urgent = reports ? reports.postsUrgent + reports.usersUrgent + (reports.dmsUrgent || 0) : 0;
  if (urgent) alerts.push({ level: "bad", text: `${urgent} urgent report${urgent === 1 ? "" : "s"} waiting`, href: "/feed/admin#urgent" });
  if (pepe && pepe.known && !pepe.online) alerts.push({ level: "bad", text: "Pepe's VM supervisor is offline", href: "/admin/pepe" });
  else if (pepe && pepe.online && !pepe.running) alerts.push({ level: "warn", text: "VM online but Pepe isn't running", href: "/admin/pepe" });
  else if (pepe && pepe.hung) alerts.push({ level: "warn", text: "Pepe looks hung (no output)", href: "/admin/pepe" });
  if (reserve && reserve.balance === null) alerts.push({ level: "warn", text: "Reserve balance never synced from Pepe - Reserve-funded payouts are skipped", href: "/admin/economy#reserve" });
  else if (reserve && reserve.syncedAt && Date.now() - reserve.syncedAt > 30 * 60 * 1000) alerts.push({ level: "warn", text: "Reserve balance not synced for over 30 minutes", href: "/admin/economy#reserve" });
  if (loans && loans.pending) alerts.push({ level: "warn", text: `${loans.pending} loan request${loans.pending === 1 ? "" : "s"} to decide`, href: "/wallet#admin-requests" });
  if (shop && shop.disputes) alerts.push({ level: "warn", text: `${shop.disputes} disputed shop order${shop.disputes === 1 ? "" : "s"}`, href: "/shop/admin" });
  if (shop && shop.review) alerts.push({ level: "info", text: `${shop.review} shop listing${shop.review === 1 ? "" : "s"} awaiting review`, href: "/shop/admin" });
  if (disk && disk.free !== null && disk.free < disk.minFreeGb * 2 * 1024 ** 3) alerts.push({ level: "warn", text: `Low disk: ${(disk.free / 1024 ** 3).toFixed(1)} GB free (uploads stop below ${disk.minFreeGb} GB)`, href: "/admin/system" });
  if (stale && stale.started) {
    const d = daysUntil(stale.applyOn);
    if (d !== null && d >= 0 && d <= 7) alerts.push({ level: "info", text: `Stale-account archive runs in ${d} day${d === 1 ? "" : "s"} (${stale.applyOn})`, href: "/admin/users#stale-admin" });
  }
  if (terms === false) alerts.push({ level: "info", text: "Terms of Service aren't enforced yet", href: "/feed/admin#settings" });
  return { isAdmin, pepe, reserve, loans, reports, stage, stale: stale ? { ...stale, daysLeft: stale.started ? daysUntil(stale.applyOn) : null } : null,
           shop, disk, terms, alerts };
}

async function systemInfo() {
  const db = await safe(async () => (await getQuery("SELECT 1 AS ok"))[0].ok === 1, false);
  const disk = await safe(async () => diskStatus());
  const feedUsed = await safe(() => require("./feedstore").usedBytes(null), null);
  return { sha: sha(), env: process.env.STAGING ? "staging" : "production", node: process.version, uptime: Math.round(process.uptime()),
           db, disk, feedUsed, started: Date.now() - Math.round(process.uptime() * 1000) };
}

function register(app, { addUser }) {
  // the old gate, unchanged (was the /admin/panel handler in index.js)
  const gate = (req, res, next) => {
    const userType = req.user ? req.user.class : null;
    if (isStaffClass(userType)) return next();
    if (typeof req.flash === "function") req.flash("error", "Access denied. You must be an admin or staff to access this page.");
    return res.redirect("/login");
  };
  const flashes = (req) => ({
    errors: typeof req.flash === "function" ? req.flash("error") : [],
    success: typeof req.flash === "function" ? req.flash("success") : [],
  });
  const page = (section, title, data) => async (req, res) => {
    try {
      const me = await freshMe(req);
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      res.render("admin/" + section, { user: req.user.username, title, section, me, isAdmin: !!me && me.class === "Admin",
                                       ...flashes(req), ...(data ? await data(req, me) : {}) });
    } catch (e) {
      console.error("[admin] " + section + ":", e);
      res.status(500).send("Couldn't load the admin page.");
    }
  };

  // Old URL: /admin/panel -> /admin (a redirect keeps the #anchor; the Overview forwards #welcome-admin / #stale-admin)
  app.get("/admin/panel", addUser, gate, (req, res) => res.redirect(302, "/admin"));
  // Short aliases for the pages that live under their own feature
  app.get("/admin/feed", (req, res) => res.redirect(302, "/feed/admin"));
  app.get("/admin/pads", (req, res) => res.redirect(302, "/pads/admin"));
  app.get("/admin/stage", (req, res) => res.redirect(302, "/stage/admin"));
  app.get("/admin/shop", (req, res) => res.redirect(302, "/shop/admin"));

  app.get("/admin", addUser, gate, page("overview", "Admin · Overview", async (req, me) => ({ ov: await overview(me) })));
  app.get("/admin/users", addUser, gate, page("users", "Admin · Users & Accounts"));
  app.get("/admin/economy", addUser, gate, page("economy", "Admin · Economy", async (req, me) => {
    const isAdmin = !!me && me.class === "Admin";
    const roy = await safe(() => require("./royalties").summary(), null);
    return { reserve: isAdmin ? await safe(reserveStatus) : null, loans: isAdmin ? await safe(loanStatus) : null, roy, shop: await safe(shopStatus),
             inc: isAdmin ? await safe(incentiveStatus) : null };
  }));
  app.get("/admin/games", addUser, gate, page("games", "Admin · Games"));
  app.get("/admin/cosmetics", addUser, gate, page("cosmetics", "Admin · Cosmetics & Achievements"));
  app.get("/admin/bridge", addUser, gate, page("bridge", "Admin · Bridge"));
  app.get("/admin/pepe", addUser, gate, page("pepe", "Admin · Pepe"));
  app.get("/admin/system", addUser, gate, page("system", "Admin · System", async () => ({ sys: await systemInfo() })));
}

module.exports = { register, overview, systemInfo, SECTION_VIEWS, daysUntil };
