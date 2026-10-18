// creatorsweb.js — the routes and pages of ⭐ PATV Creators (1.99pv; the service is creators.js).
//
//   GET  /creators                      what it is + the apply form (eligibility ticks, Creator Terms, rating, tiers)
//   GET  /creators/terms                the Creator Terms (DRAFT, for the lawyer's review; versioned)
//   GET  /creators/:username            a creator's page: tiers, Subscribe, your subscription
//   GET  /creator                       the creator dashboard (+ /creator/ledger.csv)
//   POST /api/creators/{apply, plans, age, quote, subscribe, unlock, dispute, pads, comp, broadcast}
//   POST /api/creators/subs/:id/{cancel, resume, pay, renew, tier, remove}
//   GET  /admin/creators, /admin/creators/explicit; POST /api/admin/creators/...   staff / admins
//   POST /api/creators/bot/act          Pepe (bot token): quote / subscribe / subs / creator (D13)
"use strict";
const CR = require("./creators");
const { getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

function register(app, { addUser, isBotToken }) {
  CR.init().catch((e) => console.error("[creators] init:", e.message));
  CR.start();
  // 1.99qp: the views' links to PATV Creators follow the feature switch (hidden while it's off)
  if (app.locals) { app.locals.creatorNav = (username) => CR.navFor(username); app.locals.creatorBadge = (userId) => CR.isCreatorBadge(userId); }
  const guard = require("./middleware/authGuard");
  const T = (req, k, d) => (req.t ? req.t(k) : d);
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code || null });
    console.error("[creators]", e);
    res.status(500).json({ ok: false, error: "Something went wrong - nothing was charged." });
  };
  const write = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "cross-site request refused" });
    next();
  };
  const me = async (req) => (req.user && req.user.userId ? (await getQuery("SELECT userId, username, class, level FROM users WHERE userId = ?", [req.user.userId]))[0] || null : null);
  const staff = (u) => SP.can(u, "creators.admin");                       // 1.99ack (siteperms.js)
  const explicitAdmin = (u) => SP.can(u, "creators.config_explicit");
  const post = (path, fn) => app.post(path, addUser, write, async (req, res) => {
    try { res.json({ ok: true, ...(await fn(await me(req), req.body || {}, req)) }); } catch (e) { fail(res, e); }
  });

  // ── pages ──
  app.get("/creators", addUser, async (req, res) => {
    try {
      await CR.init();
      const u = await me(req);
      const c = u ? await CR.creatorRow(u.userId) : null;
      res.render("creators", { user: u ? u.username : null, title: T(req, "cr.title", "PATV Creators"), C: CR.config(), creator: c,
                               plans: c ? await CR.plansOf(u.userId, { all: false }) : [], elig: u ? await CR.eligibility(u.userId) : null,
                               termsVersion: CR.CREATOR_TERMS_VERSION, explicit: CR.EXPLICIT_TIER_ENABLED });
    } catch (e) { console.error("[creators] page:", e); res.status(500).send("Couldn't load PATV Creators."); }
  });
  app.get("/creators/terms", addUser, (req, res) => {
    res.render("creatorTerms", { user: req.user ? req.user.username : null, title: T(req, "cr.terms.title", "PATV Creator Terms"), version: CR.CREATOR_TERMS_VERSION, C: CR.config() });
  });
  app.get("/creators/:username", addUser, async (req, res, next) => {
    if (!/^[\w.-]{1,64}$/.test(String(req.params.username || ""))) return next();
    try {
      const u = await me(req);
      const v = await CR.publicView(req.params.username, u);
      if (!v) return res.status(404).render("notFound", { user: u ? u.username : null, heading: T(req, "cr.page.none_h", "No such creator"), message: T(req, "cr.page.none_p", "That account isn't a creator."), title: "Not found" });
      res.render("creatorPage", { user: u ? u.username : null, title: `${v.user.username} · PATV Creators`, v, me: u, focusTier: Number(req.query.tier) || null,
                                  attested: u ? await CR.attested(u.userId) : false, C: CR.config() });
    } catch (e) { console.error("[creators] creator page:", e); res.status(500).send("Couldn't load that creator."); }
  });
  app.get("/creator", addUser, async (req, res) => {
    const u = await me(req);
    if (!u) return res.redirect("/login?next=" + encodeURIComponent("/creator"));
    try {
      const d = await CR.dashboard(u.userId);
      if (!d) return res.redirect("/creators");
      res.set("Cache-Control", "no-store");
      res.render("creatorDash", { user: u.username, title: T(req, "cr.dash.title", "Creator dashboard"), d, C: CR.config() });
    } catch (e) { console.error("[creators] dashboard:", e); res.status(500).send("Couldn't load your dashboard."); }
  });
  app.get("/creator/ledger.csv", addUser, async (req, res) => {
    const u = await me(req);
    if (!u) return res.status(401).end();
    if (!(await CR.creatorRow(u.userId))) return res.status(404).end();
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="patv-creator-ledger.csv"', "Cache-Control": "no-store" });
    res.send(await CR.ledgerCsv(u.userId));
  });

  // ── fan + creator API ──
  post("/api/creators/apply", async (u, b) => CR.apply(u, b));
  post("/api/creators/plans", async (u, b) => {
    if (!CR.isActiveCreator(u.userId)) throw new CR.Refuse(403, "Creators only.");
    await CR.savePlans(u.userId, CR.cleanPlans(b.plans));
    return {};
  });
  post("/api/creators/age", async (u, b) => CR.attestAge(u, b.yes));
  app.post("/api/creators/quote", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await CR.quote(await me(req), req.body || {})); } catch (e) { fail(res, e); }
  });
  post("/api/creators/subscribe", async (u, b) => CR.subscribe(u, b));
  post("/api/creators/unlock", async (u, b) => CR.unlock(u, b));
  post("/api/creators/dispute", async (u, b) => CR.dispute(u, b));
  post("/api/creators/pads", async (u, b) => CR.setPadFlags(u, b.pad, { r18: b.r18, allow_creators: b.allow_creators, attest: b.attest }));
  post("/api/creators/comp", async (u, b) => CR.comp(u, b));
  post("/api/creators/broadcast", async (u, b) => CR.broadcast(u, b));
  post("/api/creators/subs/:id/cancel", async (u, b, req) => CR.cancel(u, req.params.id));
  post("/api/creators/subs/:id/resume", async (u, b, req) => CR.resume(u, req.params.id));
  post("/api/creators/subs/:id/pay", async (u, b, req) => CR.payNow(u, req.params.id));
  post("/api/creators/subs/:id/renew-on", async (u, b, req) => CR.setRenew(u, req.params.id, true));
  post("/api/creators/subs/:id/renew-off", async (u, b, req) => CR.setRenew(u, req.params.id, false));
  post("/api/creators/subs/:id/tier", async (u, b, req) => CR.changeTier(u, req.params.id, b));
  post("/api/creators/subs/:id/remove", async (u, b, req) => CR.removeSub(u, req.params.id));

  // ── staff ──
  app.get("/admin/creators", addUser, async (req, res) => {
    const u = await me(req);
    if (!staff(u)) return res.redirect("/login");
    res.set("Cache-Control", "no-store"); res.set("X-Robots-Tag", "noindex");
    try { res.render("admin/creators", { user: u.username, isAdmin: explicitAdmin(u), A: await CR.adminView() }); }
    catch (e) { console.error("[creators] admin:", e); res.status(500).send("Couldn't load the creators admin."); }
  });
  app.get("/admin/creators/explicit", addUser, async (req, res) => {
    const u = await me(req);
    if (!explicitAdmin(u)) return res.status(u ? 403 : 302).redirect(u ? (SP.areaHome(u) || "/login") : "/login");
    res.set("Cache-Control", "no-store"); res.set("X-Robots-Tag", "noindex");
    res.render("admin/creatorsExplicit", { user: u.username, isAdmin: true, R: await CR.readiness(), STATUS: CR.GATE_STATUS });
  });
  const adminPost = (path, fn, adminOnly = false) => app.post(path, addUser, write, async (req, res) => {
    const u = await me(req);
    if (!staff(u) || (adminOnly && !explicitAdmin(u))) return res.status(403).json({ ok: false, error: adminOnly ? "Admins only." : "Staff only." });
    try { res.json({ ok: true, ...(await fn(u, req.body || {}, req)) }); } catch (e) { fail(res, e); }
  });
  adminPost("/api/admin/creators/config", async (u, b) => ({ config: await CR.setConfig(b, u.username) }), true);
  adminPost("/api/admin/creators/:userId/status", async (u, b, req) => CR.staffSet(u, req.params.userId, { status: b.action, note: b.note }));
  adminPost("/api/admin/creators/disputes/:id", async (u, b, req) => CR.resolveDispute(u, req.params.id, { action: b.action, note: b.note }));
  adminPost("/api/admin/creators/ledger/:id", async (u, b, req) => {
    if (b.action === "refund") { const ok = await CR.refundLedger(req.params.id, b.note || "refunded by the staff", u.username); if (!ok) throw new CR.Refuse(409, "It isn't held any more."); return {}; }
    if (b.action === "clawback") return CR.clawback(u, req.params.id, b.note);
    if (b.action === "release") { const r = await CR.releaseDue(); return { message: `Released ${r.released} payment(s).` }; }
    throw new CR.Refuse(400, "Unknown action.");
  });
  adminPost("/api/admin/creators/explicit/:gate", async (u, b, req) => CR.setGate(u, req.params.gate, b), true);

  // ── Pepe ──
  app.post("/api/creators/bot/act", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await CR.botAct(b)); } catch (e) { console.error("[creators] bot:", e); res.status(500).json({ ok: false, code: "failed", error: "failed" }); }
  });
}

module.exports = { register };
