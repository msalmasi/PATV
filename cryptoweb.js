// cryptoweb.js — 1.99ks: the pages + routes for stablecoin donations (cryptopay.js).
//   /support                     "Support PATV": the receiving addresses (QR + copy), accepted chains / tokens, the rate,
//                                the viewer's linked wallets + their payments (pending / credited / held / unclaimed),
//                                and the card donation when Stripe is on. 404 while both are off (admins see a preview).
//   /api/crypto/link/start       {family: evm|sol, address} -> the message to sign (nonce, domain, 10-minute expiry)
//   /api/crypto/link/finish      {nonce, signature} -> links the wallet (and credits what it sent while unlinked)
//   /api/crypto/unlink           {id}
//   /api/crypto/mine             the viewer's payments (the page refreshes with it)
//   /admin/crypto                admins: settings, watcher health, every payment, unclaimed, held (approve / reject),
//                                a read-only dry run
// Rate limits: link start 10 / 15 min per account and 30 per IP; finish 20 / 15 min per account.
"use strict";
const CP = require("./cryptopay");
const SPG = require("./supportpage");   // 1.99mn: /support extras (goal meter, total raised, recent supporters) - admin switches, off by default

const QR = new Map();
/** An inline SVG QR code for a (public) address. */
function qrSvg(text) {
  if (QR.has(text)) return QR.get(text);
  let svg = "";
  try {
    const qrcode = require("qrcode-generator");
    const q = qrcode(0, "M");
    q.addData(String(text));
    q.make();
    svg = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch (e) { svg = ""; }
  if (QR.size > 50) QR.clear();
  QR.set(text, svg);
  return svg;
}

function register(app, { addUser, noTimers } = {}) {
  const guard = require("./middleware/authGuard");
  const startUser = guard.limiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const startIp = guard.limiter({ max: 30, windowMs: 15 * 60 * 1000 });
  const finishUser = guard.limiter({ max: 20, windowMs: 15 * 60 * 1000 });
  CP.init().then(() => { if (!noTimers) CP.start(); }).catch((e) => console.error("[crypto] setup:", e.message));

  const isAdmin = (u) => !!u && u.class === "Admin";
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
    console.error("[crypto]", e && e.message);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const json = (fn, { admin = false } = {}) => [addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (admin && !isAdmin(req.user)) return res.status(403).json({ ok: false, error: "Admins only." });
    try { await CP.init(); res.json({ ok: true, ...(await fn(req, req.body || {})) }); } catch (e) { fail(res, e); }
  }];
  const stripeOn = () => { try { return require("./stripebilling").enabled(); } catch (e) { return false; } };
  // 1.99kz: the navbar / footer "Support PATV" links (views/layout.ejs) show while /support has something to offer
  app.locals.supportOn = () => { try { return CP.enabled() || stripeOn(); } catch (e) { return false; } };

  app.get("/support", addUser, async (req, res, next) => {
    try {
      await CP.init();
      const admin = isAdmin(req.user);
      const cryptoOn = CP.enabled();
      if (!cryptoOn && !stripeOn() && !admin) return next("route");
      const me = req.user && req.user.userId ? req.user : null;
      const chains = CP.accepted().map((c) => ({ ...c, qr: qrSvg(c.address) }));
      const T = CP.patFor(100);
      let donate = null;
      try { donate = { ...require("./stripebilling").donateLocals("/support", req.query.donate), onSupport: true }; } catch (e) { donate = null; }
      // 1.99mn design pass: the optional goal / total / recent supporters (supportpage.js, all off by default), the viewer's
      // name opt-in, and the thank-you after Stripe's redirect (the newest card donation credited in the last hour, if any)
      let sp = {}, showName = false, thanks = null;
      try {
        sp = await SPG.pageData();
        if (me) showName = await SPG.showName(me.userId);
        if (me && donate && donate.result === "success") thanks = await SPG.latestCard(me.userId);
      } catch (e) { console.error("[support] page extras:", e.message); }
      res.render("support", {
        user: me ? me.username : null, title: req.t ? req.t("support.title") : "Support PATV",
        cryptoOn, preview: !cryptoOn && admin, chains, me: !!me,
        wallets: me ? await CP.wallets(me.userId) : [], payments: me ? await CP.mine(me.userId) : [],
        rate: T.rate, bonus_pct: T.bonus_pct, min: CP.get().min_usd, max: CP.get().max_usd, donate, sp, showName, thanks,
      });
    } catch (e) { next(e); }
  });
  app.get("/api/crypto/mine", ...json(async (req) => ({ wallets: await CP.wallets(req.user.userId), payments: await CP.mine(req.user.userId) })));
  app.post("/api/crypto/link/start", ...json(async (req, b) => {
    const ip = guard.clientIp(req);
    if (startUser.blocked(req.user.userId) || startIp.blocked(ip)) throw Object.assign(new Error("Too many wallet links - try again in a few minutes."), { status: 429, refuse: true });
    startUser.hit(req.user.userId); startIp.hit(ip);
    return CP.linkStart(req.user, String(b.family || ""), String(b.address || ""), req.get("host"));
  }));
  app.post("/api/crypto/link/finish", ...json(async (req, b) => {
    if (finishUser.blocked(req.user.userId)) throw Object.assign(new Error("Too many wallet links - try again in a few minutes."), { status: 429, refuse: true });
    finishUser.hit(req.user.userId);
    return CP.linkFinish(req.user, String(b.nonce || ""), String(b.signature || ""));
  }));
  app.post("/api/crypto/unlink", ...json(async (req, b) => CP.unlink(req.user, b.id)));
  // 1.99mn: the viewer's "show my name in recent supporters" opt-in; the admin switches for the page extras
  app.post("/api/support/prefs", ...json(async (req, b) => SPG.setShowName(req.user.userId, !!b.show_name)));
  app.post("/api/support/admin/settings", ...json(async (req, b) => SPG.set(b, req.user.username), { admin: true }));

  // ── admin ──
  app.get("/admin/crypto", addUser, async (req, res, next) => {
    if (!isAdmin(req.user)) return res.redirect("/login");
    try {
      await CP.init();
      await SPG.init();
      const [health, payments, unclaimed, held, suspect, totals] = await Promise.all([CP.health(), CP.adminList({ limit: 200 }),
        CP.adminList({ status: "unclaimed" }), CP.adminList({ status: "held" }), CP.adminList({ status: "suspect" }), CP.totals()]);
      res.render("cryptoAdmin", { user: req.user.username, S: CP.get(), health, payments, unclaimed, held, suspect, totals,
        accepted: CP.accepted(), terms: CP.patFor(100), stripe: stripeOn(), SPS: SPG.get() });
    } catch (e) { next(e); }
  });
  app.get("/api/crypto/admin/health", ...json(async () => ({ health: await CP.health(), totals: await CP.totals() }), { admin: true }));
  app.post("/api/crypto/admin/settings", ...json(async (req, b) => CP.set(b, req.user.username), { admin: true }));
  app.post("/api/crypto/admin/decide", ...json(async (req, b) => CP.decide(String(b.id || ""), String(b.action || ""), req.user.username, b.note), { admin: true }));
  app.post("/api/crypto/admin/poll", ...json(async () => ({ result: await CP.pollOnce({ force: true }) }), { admin: true }));
  app.post("/api/crypto/admin/dryrun", ...json(async (req, b) => ({ result: await CP.dryRun({ blocks: Math.max(10, Math.min(20000, Number(b.blocks) || 5000)),
    sigs: Math.max(1, Math.min(200, Number(b.sigs) || 50)) }) }), { admin: true }));
}

module.exports = { register, qrSvg };
