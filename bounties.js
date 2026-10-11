// bounties.js — Pepe's bounty board on PATV.
//
// The bounties themselves (escrowed pots, claims, payouts) run in Pepe; he pushes a snapshot of
// every bounty here whenever one changes. A signed-in user can chip in, claim, and (if they posted
// it) resolve or cancel from the site: each of those is queued as an action that Pepe claims every
// few seconds, runs through the same checks as the chat command, and acks. An action carries its
// id, so one claimed twice (Pepe restarted mid-way) is never applied twice.
//
// 1.99ou Phase 2: with the bounties cut over to the site (escrow/bounties.js, escrow_meta live:bounties) the site owns them:
// the engine keeps the `bounties` table below itself (mirror()), the /bounties/:id/:kind forms run on the engine at once,
// Pepe's /api/bounties/sync is ignored and /api/bounties/actions/claim hands out nothing (the queue is retired while the
// switch is on - it stays for the local plugin path).
const { runQuery, getQuery } = require("./dbUtils");
const actions = require("./actions");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS bounties (
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, status TEXT, deadline INTEGER, updated INTEGER)`).catch(() => {});
const actionsReady = runQuery(`CREATE TABLE IF NOT EXISTS bounty_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bounty_id INTEGER NOT NULL, user_id TEXT NOT NULL,
  username TEXT NOT NULL, camfrog TEXT, kind TEXT NOT NULL, amount INTEGER, note TEXT, hunters TEXT,
  site_admin INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', message TEXT,
  created INTEGER, claimed INTEGER, updated INTEGER)`).catch(() => {});
// 1.99bl: claims carry evidence (a note + http(s) links - the site has no user uploads) and Pepe's
// check of his logs; the creator (or an admin, for disputed ones) can reject a claim, the hunter can
// dispute a rejection (or a claim the creator sat on for 12 h) to the admins.
const evidenceCol = actionsReady.then(() => runQuery("ALTER TABLE bounty_actions ADD COLUMN evidence TEXT")).catch(() => {});
const ttl = require("./actionttl");     // 1.99ne: queued actions expire
const ADD_MIN = 100;
const DISPUTE_AFTER_S = 12 * 3600;
const CHECK_STATES = ["verified", "creator", "admin", "no_match", "manual"];

// Only plain http(s) links survive (no javascript:/data: etc.), at most 3, 300 chars each.
function cleanLink(u) {
  const s = String(u || "").trim().slice(0, 300);
  if (!/^https?:\/\/[^\s<>"']+$/i.test(s)) return null;
  try { const x = new URL(s); return (x.protocol === "http:" || x.protocol === "https:") ? x.href : null; } catch (e) { return null; }
}

// One claim from Pepe's snapshot, cleaned for storage.
function cleanClaim(c) {
  const ev = c.evidence && typeof c.evidence === "object" ? c.evidence : null;
  const ck = c.check && typeof c.check === "object" ? c.check : null;
  return {
    nick: String(c.nick || "").slice(0, 60), ts: Number(c.ts) || 0, note: String(c.note || "").slice(0, 160),
    evidence: ev ? { text: String(ev.text || "").slice(0, 160), links: [].concat(ev.links || []).map(cleanLink).filter(Boolean).slice(0, 3) } : null,
    check: ck && CHECK_STATES.includes(ck.state) ? { state: ck.state, how: ck.how === "semantic" ? "semantic" : (ck.how ? "exact" : null),
      lines: [].concat(ck.lines || []).slice(0, 4).map((l) => String(l).slice(0, 240)), why: String(ck.why || "").slice(0, 200) } : null,
    rejected: c.rejected ? { by: String(c.rejected.by || "").slice(0, 60), why: String(c.rejected.why || "").slice(0, 160) } : null,
    disputed: !!c.disputed,
  };
}

// One bounty from Pepe's snapshot (or the site's own engine, escrow/bounties.js mirror()), cleaned for storage.
function cleanSnap(b) {
  const id = parseInt(b && b.id, 10);
  if (!id) return null;
  return {
    id, creator: String(b.creator || "").slice(0, 60), task: String(b.task || "").slice(0, 300),
    room: String(b.room || "").slice(0, 80), status: String(b.status || "open").slice(0, 20),
    created: Number(b.created) || 0, deadline: Number(b.deadline) || 0,
    pot: (b.pot || []).slice(0, 500).map((c) => ({ nick: String(c.nick || "").slice(0, 60), amount: Math.floor(Number(c.amount) || 0) })),
    claims: (b.claims || []).slice(0, 200).map(cleanClaim),
    hunters: (b.hunters || []).slice(0, 50).map((h) => String(h).slice(0, 60)),
    resolved: Number(b.resolved) || null,
    verify: b.verify && b.verify.text ? { text: String(b.verify.text).slice(0, 300), action: String(b.verify.action || "").slice(0, 20) } : null,
    auto: !!b.auto,
  };
}
async function storeSnap(clean) {
  await ready;
  await runQuery(`INSERT INTO bounties (id, data, status, deadline, updated) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status,
                  deadline = excluded.deadline, updated = excluded.updated`,
    [clean.id, JSON.stringify(clean), clean.status, clean.deadline, Date.now()]);
}

// What the viewer may do with one claim on an open bounty.
function claimPerms(b, c, { mine, creator, admin, now }) {
  const open = b.status === "open";
  return {
    reject: open && (creator || admin) && !mine && !(c.disputed && !admin) && !(c.rejected && !c.disputed),
    dispute: open && mine && !c.disputed && (!!c.rejected || (now - (c.ts || now)) >= DISPUTE_AFTER_S),
  };
}
const RECLAIM_MS = 2 * 60 * 1000;
const KEEP_DAYS = 60;

const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

function view(b, me) {
  const pot = (b.pot || []).reduce((a, c) => a + (Number(c.amount) || 0), 0);
  const backers = {};
  for (const c of b.pot || []) backers[c.nick] = (backers[c.nick] || 0) + (Number(c.amount) || 0);
  const claims = (b.claims || []).slice().sort((x, y) => (x.ts || 0) - (y.ts || 0));
  const keys = (me || []).filter(Boolean);
  return {
    ...b, ref: `BT${b.id}`, total: pot, claims,
    backers: Object.entries(backers).map(([nick, amount]) => ({ nick, amount })).sort((x, y) => y.amount - x.amount),
    mineCreator: keys.some((k) => same(k, b.creator)),
    mineClaim: claims.find((c) => keys.some((k) => same(k, c.nick))) || null,
  };
}

function register(app, { isBotToken, addUser }) {
  require("./userlinks").install(app);   // 1.99dt: <%- ul(name) %> in its views links names to profiles
  async function whoAmI(req) {
    if (!req.user || !req.user.userId) return null;
    const u = await getQuery("SELECT username, camfrogUsername, class, points_balance, casino_banned FROM users WHERE userId = ?", [req.user.userId]);
    return u[0] || null;
  }

  // Pepe pushes every bounty here
  app.post("/api/bounties/sync", async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    const list = Array.isArray(body.bounties) ? body.bounties.slice(0, 1000) : [];
    try {
      await ready;
      // 1.99ou: while the site owns the bounties (escrow/bounties.js) it keeps this table itself - a late snapshot from Pepe
      // must not overwrite it
      if (await require("./escrow/games").gameLive("bounties")) return res.json({ success: true, stored: 0, live: true });
      for (const b of list) {
        const clean = cleanSnap(b);
        if (clean) await storeSnap(clean);
      }
      await runQuery("DELETE FROM bounties WHERE status != 'open' AND updated < ?", [Date.now() - KEEP_DAYS * 86400000]);
      res.json({ success: true, stored: list.length });
    } catch (e) {
      console.error("[bounties] sync:", e);
      res.status(500).json({ success: false });
    }
  });

  // A signed-in user acts on a bounty
  app.post("/bounties/:id/:kind", addUser, async (req, res) => {
    const id = parseInt(String(req.params.id).replace(/^bt/i, ""), 10);
    const kind = String(req.params.kind);
    const back = (msg) => res.redirect(`/bounties/${id}?msg=${encodeURIComponent(msg)}`);
    if (!["add", "claim", "resolve", "cancel", "reject", "dispute"].includes(kind)) return res.status(404).send("Not found");
    if (!req.user || !req.user.userId) return res.redirect("/login");
    try {
      await ready; await actionsReady;
      const rows = await getQuery("SELECT data FROM bounties WHERE id = ?", [id]);
      if (!rows.length) return back("That bounty doesn't exist.");
      const b = JSON.parse(rows[0].data);
      if (b.status !== "open") return back(`That bounty is ${b.status}.`);
      const u = await whoAmI(req);
      if (!u) return back("Couldn't find your account.");
      const me = [u.camfrogUsername, u.username];
      const creator = me.some((k) => same(k, b.creator));
      const body = req.body || {};
      let amount = null, note = null, hunters = null, evidence = null, ok = "";
      const myClaim = (b.claims || []).find((c) => me.some((k) => same(k, c.nick)));
      if (kind === "add") {
        if (b.deadline * 1000 < Date.now()) return back("That bounty has expired.");
        amount = require("./public/js/patamount").parse(body.amount) || 0;    // 1.99nk: "1,000,000" / "5k" (Pepe's rules)
        if (amount < ADD_MIN) return back(`Chip in at least ${ADD_MIN.toLocaleString()} PAT.`);
        if (Number(u.points_balance) < amount) return back(`You only have ${Number(u.points_balance).toLocaleString()} PAT.`);
        ok = `Sent to Pepe: adding ${amount.toLocaleString()} PAT to the pot.`;
      } else if (kind === "claim") {
        if (b.deadline * 1000 < Date.now()) return back("That bounty has expired.");
        if (creator) return back("You can't claim your own bounty.");
        note = String(body.note || "").trim().slice(0, 160);
        const raw = String(body.evidence || "").trim();
        if (raw) {
          evidence = cleanLink(raw);
          if (!evidence) return back("Evidence has to be a link (http:// or https://) — a clip, a snap, a screenshot.");
        }
        ok = b.verify ? "Sent to Pepe: your claim. He'll check his logs and reply here."
                      : "Sent to Pepe: your claim. The poster picks who gets paid.";
      } else if (kind === "reject") {
        if (!creator && u.class !== "Admin") return back(`Only ${b.creator} (or an admin) can reject a claim.`);
        const c = (b.claims || []).find((x) => x.nick === String(body.hunter || ""));
        if (!c) return back("That person hasn't claimed it.");
        if (c.disputed && u.class !== "Admin") return back("That claim is with the admins now.");
        hunters = JSON.stringify([c.nick]);
        note = String(body.note || "").trim().slice(0, 160);
        ok = `Sent to Pepe: rejecting ${c.nick}'s claim.`;
      } else if (kind === "dispute") {
        if (!myClaim) return back("You haven't claimed it.");
        if (myClaim.disputed) return back("Your claim is already with the admins.");
        if (!myClaim.rejected && Date.now() / 1000 - (myClaim.ts || 0) < DISPUTE_AFTER_S)
          return back(`Give ${b.creator} a chance first — you can dispute once they reject it, or 12 hours after you claimed.`);
        note = String(body.note || "").trim().slice(0, 160);
        ok = "Sent to Pepe: your dispute goes to the admins.";
      } else {
        if (!creator && u.class !== "Admin") return back(`Only ${b.creator} (or an admin) can do that.`);
        if (kind === "resolve") {
          const pick = [].concat(body.hunters || []).map((h) => String(h)).filter((h) => (b.claims || []).some((c) => c.nick === h));
          if (!pick.length) return back("Tick at least one hunter who claimed it.");
          hunters = JSON.stringify(pick.slice(0, 20));
          ok = `Sent to Pepe: paying ${pick.join(", ")}.`;
        } else {
          ok = "Sent to Pepe: cancelling — everyone who chipped in is refunded.";
        }
      }
      // 1.99ou Phase 2: while the site owns the bounties (escrow/bounties.js) the action runs here, now - nothing is queued for
      // Pepe (the bounty_actions queue is retired while the switch is on; it stays for the local plugin path)
      const games = require("./escrow/games");
      if (await games.gameLive("bounties")) {
        const E = require("./escrow/bounties");
        const verb = kind === "cancel" ? (creator ? "cancel" : "void") : kind;
        const args = { ref: `BT${id}` };
        if (kind === "add") args.amount = amount;
        else if (kind === "claim") { args.note = note; args.link = evidence || ""; }
        else if (kind === "reject") { args.hunter = JSON.parse(hunters)[0]; args.why = note; }
        else if (kind === "dispute") args.why = note;
        else if (kind === "resolve") args.hunters = JSON.parse(hunters);
        const actor = { userId: req.user.userId, username: u.username, login: u.camfrogUsername || null, admin: u.class === "Admin", via: "web" };
        const idem = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.idem || "")) ? `web-${req.user.userId}-${body.idem}` : null;
        const r = await games.act("bounties", { verb, actor, args, idem });
        return back(E.webReply(verb, r, args));
      }
      const open = await getQuery("SELECT COUNT(*) AS n FROM bounty_actions WHERE user_id = ? AND status IN ('pending','claimed')", [req.user.userId]);
      if (open[0].n >= 5) return back("You already have actions waiting — give Pepe a moment.");
      await evidenceCol;
      await runQuery(`INSERT INTO bounty_actions (bounty_id, user_id, username, camfrog, kind, amount, note, hunters, evidence, site_admin, status, created, updated)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [id, req.user.userId, u.username, u.camfrogUsername || null, kind, amount, note, hunters, evidence,
         u.class === "Admin" ? 1 : 0, Date.now(), Date.now()]);
      back(ok);
    } catch (e) {
      console.error(`[bounties] ${kind}:`, e);
      back("Something went wrong — nothing changed. Try again.");
    }
  });

  // Pepe takes the pending actions (and any claimed ones he never answered)
  app.post("/api/bounties/actions/claim", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    await actionsReady; await evidenceCol;
    // 1.99ou: while the site owns the bounties nothing is handed to Pepe (he doesn't run the local engine then); a row that
    // somehow got queued is answered here so it doesn't sit "pending" for ever
    if (await require("./escrow/games").gameLive("bounties")) {
      await runQuery("UPDATE bounty_actions SET status = 'failed', message = ?, updated = ? WHERE status IN ('pending','claimed')",
                     ["The bounty board runs on publicaccess.tv now - nothing happened; send it again.", Date.now()]);
      return res.json({ actions: [], live: true });
    }
    // 1.99ne: overdue pending actions expire first (actionttl.js)
    await ttl.sweepTable("bounty_actions").catch((e) => console.error("[bounties] ttl sweep:", e.message));
    const now = Date.now();
    const found = await getQuery(`SELECT * FROM bounty_actions WHERE status = 'pending' OR (status = 'claimed' AND claimed < ?)
                                 ORDER BY id LIMIT 20`, [now - RECLAIM_MS]);
    const rows = [];
    for (const a of found) {
      const r = await runQuery(`UPDATE bounty_actions SET status = 'claimed', claimed = ?, updated = ?
                                WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND claimed < ?))`, [now, now, a.id, now - RECLAIM_MS]);
      if (r && r.changes === 1) rows.push(a);
    }
    res.json({ actions: rows.map((a) => {
      let hunters = [];
      try { hunters = JSON.parse(a.hunters || "[]"); } catch (e) { hunters = []; }
      return { id: a.id, bounty_id: a.bounty_id, username: a.username, camfrog: a.camfrog, kind: a.kind,
               amount: a.amount, note: a.note, hunters, evidence: a.evidence || null, site_admin: !!a.site_admin,
               created: a.created || null, expires_at: ttl.expiresAt("bounty_actions", a) };   // 1.99ne
    }) });
  });

  app.post("/api/bounties/actions/ack", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    await actionsReady;
    for (const r of ((req.body || {}).results || []).slice(0, 50)) {
      await runQuery("UPDATE bounty_actions SET status = ?, message = ?, updated = ? WHERE id = ?",
        [r.ok ? "done" : "failed", String(r.message || "").slice(0, 200), Date.now(), parseInt(r.id, 10) || 0]);
    }
    res.json({ ok: true });
  });

  app.get("/bounties", addUser, async (req, res) => {
    await ready;
    const rows = (await getQuery("SELECT data FROM bounties ORDER BY id DESC LIMIT 300")).map((r) => view(JSON.parse(r.data)));
    const now = Date.now() / 1000;
    const live = rows.filter((b) => b.status === "open").sort((a, b) => b.total - a.total);
    const done = rows.filter((b) => b.status !== "open").sort((a, b) => (b.resolved || b.deadline) - (a.resolved || a.deadline)).slice(0, 40);
    let linked = false, acts = [];
    if (req.user && req.user.userId) {
      const u = await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [req.user.userId]);
      linked = !!(u[0] && u[0].camfrogUsername);
      acts = await actions.recentFor(req.user.userId, "bounties");
    }
    res.render("bounties", { user: req.user ? req.user.username : null, live, done, now, linked, acts,
                             msg: req.query.msg ? String(req.query.msg).slice(0, 200) : null });
  });

  app.get("/bounties/:id", addUser, async (req, res) => {
    await ready;
    const id = parseInt(String(req.params.id).replace(/^bt/i, ""), 10);
    const rows = id ? await getQuery("SELECT data FROM bounties WHERE id = ?", [id]) : [];
    const base = { user: req.user ? req.user.username : null, now: Date.now() / 1000, actions: [], bal: null, isAdmin: false,
                   msg: req.query.msg ? String(req.query.msg).slice(0, 200) : null, addMin: ADD_MIN };
    if (!rows.length) return res.status(404).render("bounty", { ...base, b: null });
    let me = null;
    if (req.user && req.user.userId) {
      await actionsReady;
      base.actions = await getQuery("SELECT * FROM bounty_actions WHERE user_id = ? AND bounty_id = ? ORDER BY id DESC LIMIT 10", [req.user.userId, id]);
      const u = await whoAmI(req);
      if (u) {
        me = [u.camfrogUsername, u.username];
        base.bal = Number(u.points_balance);
        base.isAdmin = u.class === "Admin";
      }
    }
    res.locals.og = require("./og").forBounty(req, JSON.parse(rows[0].data));
    const bv = view(JSON.parse(rows[0].data), me);
    const ctx = { creator: bv.mineCreator, admin: base.isAdmin, now: base.now };
    bv.claims = bv.claims.map((c) => ({ ...c, perms: claimPerms(bv, c, { ...ctx, mine: !!me && me.some((k) => same(k, c.nick)) }) }));
    res.render("bounty", { ...base, b: bv });
  });
}

module.exports = { register, view, cleanLink, cleanClaim, claimPerms, cleanSnap, storeSnap };
