// adminweb.js — the admin area (1.99cv): /admin (Overview) + its section pages, all inside one shell
// (views/partials/admin-open.ejs / admin-close.ejs, sidebar in views/partials/admin-nav.ejs).
//
//   /admin              Overview: Pepe, Reserve, reports, loan requests, stage, stale cleanup, alerts; S1 V2: the chat hub's
//                       reports card (open reports, > 14-day escalations - <patv-modtools>, chatwidget.overviewCard)
//   /admin/users        roles + classes, XP, welcome bonus, stale-account cleanup
//   /admin/economy      Reserve + today's flows, loans/credit, PAT grants, redemption codes, royalties, shop
//   /admin/games        manual wheel spin, jackpot top-up, casino front end (1.99ol), casino bans (where they live), GTF heist market settings (1.99xq), duel / brawl knobs #pvp (1.99yc, pvpcfg.js)
//   /admin/cosmetics    badges (create / list / delete), links to cosmetics + achievements
//   /admin/bridge       the web command audit log (GET /api/bridge/cmdlog, admins only)
//   /admin/pepe         the Pepe control panel (views/partials/pepe-control.ejs) + where his feed settings live
//   /admin/system       site health: version, uptime, database, disk
//   /feed/admin, /pads/admin, /stage/admin render in the same shell (their own routes and gates).
//
// Every page here has the gate the old /admin/panel had: admin.area (siteperms.js - Admin / Staff by default), else a
// flash + redirect to /login (1.99ack: an Assistant holding a page's own capability is sent to that page instead).
// Admin-only data (Pepe, Reserve, loans, stale cleanup: admin.sensitive_overview; DM reports: dm.report_review) is
// only read for an account whose class in the DATABASE holds it, like the APIs behind those cards check.
// Old URLs: /admin/panel (and its #welcome-admin / #stale-admin anchors) -> /admin, which forwards the anchors.
"use strict";
const { execFileSync } = require("child_process");
const { getQuery } = require("./dbUtils");
const SP = require("./siteperms");

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
                               WHERE settled = 0 AND COALESCE(queued, 0) = 0 AND flow NOT LIKE 'incentives:%' AND flow NOT LIKE 'mint:%'`))[0].t;   // 1.99jw: mints aren't the Reserve's
  const jp = await safe(async () => (await getQuery("SELECT COALESCE(SUM(amount), 0) AS t FROM jackpot_rakes"))[0].t, null);
  // PO-0b: once the pools are cut over the Reserve is the site's own pool - its balance is read there (reserveNow), not
  // from Pepe's last sync
  const onSite = await safe(() => require("./pools").live(), false);
  return { balance: onSite ? await safe(() => funding.reserveNow(), null) : funding.state.reserve, onSite, syncedAt: funding.state.syncedAt || 0,
           today, todayTotal: today.reduce((a, r) => a + (r.t || 0), 0), unsettled: uns, jackpot: jp };
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
async function reportStatus(me) {
  const store = require("./feedstore");
  const posts = await store.reports();
  const users = await store.userReports();
  const dms = SP.can(me, "dm.report_review") ? await safe(() => require("./messages").reportQueue(), []) : null;
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
  const isAdmin = SP.can(me, "admin.sensitive_overview");
  const [reports, stage, shop] = await Promise.all([safe(() => reportStatus(me)), safe(stageStatus), safe(shopStatus)]);
  const [pepe, reserve, loans, stale] = isAdmin
    ? await Promise.all([safe(pepeStatus), safe(reserveStatus), safe(loanStatus), safe(staleStatus)])
    : [null, null, null, null];
  const disk = await safe(async () => diskStatus());
  const terms = await safe(async () => require("./terms").enforced(), null);
  const push = isAdmin ? await safe(() => require("./webpush").health(), null) : null;   // 1.99acd: browser notifications (webpush.js)

  // alerts: the things worth acting on now, most urgent first
  const alerts = [];
  const urgent = reports ? reports.postsUrgent + reports.usersUrgent + (reports.dmsUrgent || 0) : 0;
  if (urgent) alerts.push({ level: "bad", text: `${urgent} urgent report${urgent === 1 ? "" : "s"} waiting`, href: "/feed/admin#urgent" });
  if (pepe && pepe.known && !pepe.online) alerts.push({ level: "bad", text: "Pepe's VM supervisor is offline", href: "/admin/pepe" });
  else if (pepe && pepe.online && !pepe.running) alerts.push({ level: "warn", text: "VM online but Pepe isn't running", href: "/admin/pepe" });
  else if (pepe && pepe.hung) alerts.push({ level: "warn", text: "Pepe looks hung (no output)", href: "/admin/pepe" });
  if (reserve && reserve.balance === null) alerts.push({ level: "warn", text: "Reserve balance never synced from Pepe - Reserve-funded payouts are skipped", href: "/admin/economy#reserve" });
  else if (reserve && reserve.syncedAt && Date.now() - reserve.syncedAt > 30 * 60 * 1000) alerts.push({ level: "warn", text: "Reserve balance not synced for over 30 minutes", href: "/admin/economy#reserve" });
  if (loans && loans.pending) alerts.push({ level: "warn", text: `${loans.pending} loan request${loans.pending === 1 ? "" : "s"} to decide`, href: "/admin/economy#admin-requests" });
  if (shop && shop.disputes) alerts.push({ level: "warn", text: `${shop.disputes} disputed shop order${shop.disputes === 1 ? "" : "s"}`, href: "/shop/admin" });
  if (shop && shop.review) alerts.push({ level: "info", text: `${shop.review} shop listing${shop.review === 1 ? "" : "s"} awaiting review`, href: "/shop/admin" });
  if (disk && disk.free !== null && disk.free < disk.minFreeGb * 2 * 1024 ** 3) alerts.push({ level: "warn", text: `Low disk: ${(disk.free / 1024 ** 3).toFixed(1)} GB free (uploads stop below ${disk.minFreeGb} GB)`, href: "/admin/system" });
  if (stale && stale.started) {
    const d = daysUntil(stale.applyOn);
    if (d !== null && d >= 0 && d <= 7) alerts.push({ level: "info", text: `Stale-account archive runs in ${d} day${d === 1 ? "" : "s"} (${stale.applyOn})`, href: "/admin/users#stale-admin" });
  }
  if (terms === false) alerts.push({ level: "info", text: "Terms of Service aren't enforced yet", href: "/feed/admin#settings" });
  // 1.99acd: Web Push switched on without a key pair, a push service refusing our VAPID signature, or many failed pushes
  if (push && push.enabled && !push.keys.configured) alerts.push({ level: "warn", text: `Web Push is on but has no VAPID keys (${push.keys.why}) - nothing is sent`, href: "/admin/push" });
  if (push && push.vapidErrorAt && Date.now() - push.vapidErrorAt < 3600e3) alerts.push({ level: "warn", text: `A push service refused our VAPID signature (${push.vapidErrorStatus || 401}) in the last hour`, href: "/admin/push#health" });
  const pushFailed = push ? push.totals.failed || 0 : 0;
  if (push && pushFailed > Math.max(20, (push.totals.sent || 0) / 2)) alerts.push({ level: "warn", text: `${pushFailed} browser notifications failed in the last 24 h`, href: "/admin/push#health" });
  // 1.99acf: a bot key in enforce refused in the last hour (botkeys.js) - a route its scopes miss
  const refused = isAdmin ? await safe(() => require("./botkeys").recentRefusals(3600e3), []) : [];
  if (refused && refused.length) {
    const r = refused[0];
    alerts.push({ level: "warn", text: `Bot key "${r.caller}" was refused on ${r.family} in the last hour${refused.length > 1 ? ` (+${refused.length - 1} more)` : ""}`, href: "/admin/keys#scopes" });
  }
  return { isAdmin, pepe, reserve, loans, reports, stage, stale: stale ? { ...stale, daysLeft: stale.started ? daysUntil(stale.applyOn) : null } : null,
           shop, disk, terms, alerts };
}

async function systemInfo() {
  const db = await safe(async () => (await getQuery("SELECT 1 AS ok"))[0].ok === 1, false);
  const disk = await safe(async () => diskStatus());
  const feedUsed = await safe(() => require("./feedstore").usedBytes(null), null);
  // 1.99afn: ALIAS_SECRET (the frog names' key) - "set" | "missing" | "invalid", never the value
  const aliasSecret = await safe(async () => require("./frognames").secretState(), "unknown");
  return { sha: sha(), env: process.env.STAGING ? "staging" : "production", node: process.version, uptime: Math.round(process.uptime()),
           db, disk, feedUsed, started: Date.now() - Math.round(process.uptime() * 1000), aliasSecret };
}

function register(app, { addUser }) {
  // the old gate (was the /admin/panel handler in index.js), now admin.area (1.99ack siteperms.js)
  const gate = SP.gate();
  const flashes = (req) => ({
    errors: typeof req.flash === "function" ? req.flash("error") : [],
    success: typeof req.flash === "function" ? req.flash("success") : [],
  });
  const page = (section, title, data) => async (req, res) => {
    try {
      const me = await freshMe(req);
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      res.render("admin/" + section, { user: req.user.username, title, section, me, isAdmin: SP.can(me, "admin.sensitive_overview"),
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

  // S1 V2: + the chat hub's reports card (<patv-modtools view="reports" mode="card">, chatwidget.overviewCard) for chat.mod_queue
  app.get("/admin", addUser, gate, require("./chatwidget").overviewCard(), page("overview", "Admin · Overview", async (req, me) => ({ ov: await overview(me) })));
  app.get("/admin/users", addUser, gate, page("users", "Admin · Users & Accounts"));
  app.get("/admin/economy", addUser, gate, page("economy", "Admin · Economy", async (req, me) => {
    const isAdmin = SP.can(me, "admin.sensitive_overview");
    const roy = await safe(() => require("./royalties").summary(), null);
    return { reserve: isAdmin ? await safe(reserveStatus) : null, loans: isAdmin ? await safe(loanStatus) : null, roy, shop: await safe(shopStatus),
             inc: isAdmin ? await safe(incentiveStatus) : null,
             // 1.99jw: Pepe's monetary policy (flash switches, Fed loan room, House floor, donation rate, grant cap)
             monetary: isAdmin ? require("./funding").state.monetary : null,
             // 1.99xs: the Reserve desk (wallet.adminBook; was the ADMIN sections of /wallet) + the loan commands' results
             book: isAdmin ? await safe(() => require("./wallet").adminBook(), null) : null,
             acts: isAdmin ? await safe(() => require("./actions").recentFor(me.userId, "admin-loans"), []) : [],
             // 1.99ada: the 💸 payout recipe card's form is live only for a Pepe owner (recipecfg.canEdit; the API re-checks)
             rcfgEdit: await safe(() => require("./recipecfg").canEdit(me), false),
             // staking fix plan: the 🏦 staking card's switches are live only for a Pepe owner (capital/watch.canEdit; the API re-checks)
             stkEdit: await safe(() => require("./capital/watch").canEdit(me), false),
             // PO-0b (D-6): the PAT grant and the burn are a Pepe owner's - the cards say so to an Admin who isn't one
             econOwner: !!(await safe(() => require("./staffroles").ownerOf(me, "econ.grant_pat"), null)),
             msg: require("./notices").read(req) };        // 1.99ade: ?m=<id> (notices.js), never ?msg= text
  }));
  // 1.99ol: + the casino front-end switches (casino_settings bj_front / hm_front; saved through /api/casino/admin/settings)
  // 1.99xq: + the GTF heist market settings (heistmarket.adminView; was a card on /gtf/market), admins only
  app.get("/admin/games", addUser, gate, page("games", "Admin · Games", async (req, me) => ({ casino: await safe(() => require("./casino/service").loadSettings(true), null),
    hm: SP.can(me, "games.config") ? await safe(() => require("./heistmarket").adminView(), null) : null })));
  app.get("/admin/cosmetics", addUser, gate, page("cosmetics", "Admin · Cosmetics & Achievements"));
  app.get("/admin/bridge", addUser, gate, page("bridge", "Admin · Bridge"));
  // wave 3 (design §N.3): + 🧠 Pepe's memory - how many people opted out (never who), admins only
  app.get("/admin/pepe", addUser, gate, page("pepe", "Admin · Pepe", async (req, me) => ({
    mem: SP.can(me, "admin.sensitive_overview") ? await safe(() => require("./memoryoptout").adminSummary(), null) : null })));
  app.get("/admin/system", addUser, gate, page("system", "Admin · System", async () => ({ sys: await systemInfo() })));
}

module.exports = { register, overview, systemInfo, SECTION_VIEWS, daysUntil };
