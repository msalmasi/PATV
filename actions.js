// actions.js — doing things in Pepe's games from the website (1.90).
//
// A signed-in user submits a form; we store it as an action and Pepe claims pending actions every
// few seconds, runs each AS that user through the same chat command (so every rule and fee is the
// same as in a room), and acks with what he would have replied. Pages show the user's recent actions
// with that reply. Most actions need a linked Camfrog name, because in chat you ARE that name.
//
// Forms post to /act with:
//   kind   cmd | poll.vote | poll.create | poll.end
//          (kind "table" — Hold'em/Blackjack seat actions — is queued by tables.js from /api/tables/act
//          and claimed on its own fast lane, /api/tables/claim; the claim below never hands it out)
//   cmd    for kind=cmd: market | pool | wager | bounty | stash | loan | lotto
//   a0..a19  the words, in order (empty ones are skipped). For kind=cmd they're joined into the
//          command's arguments, e.g. cmd=wager a0=@bob a1=10k a2="Lakers win" a3=judge a4=@carol
//   back   the page to return to (a local path)
//   tag    which page's activity list this belongs to (defaults to the first part of `back`)
const { runQuery, getQuery } = require("./dbUtils");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS pepe_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT NOT NULL, camfrog TEXT,
  site_admin INTEGER DEFAULT 0, kind TEXT NOT NULL, args TEXT NOT NULL, tag TEXT, label TEXT,
  status TEXT NOT NULL DEFAULT 'pending', message TEXT, created INTEGER, claimed INTEGER, updated INTEGER)`).catch(() => {});
const RECLAIM_MS = 2 * 60 * 1000;
const KINDS = new Set(["cmd", "poll.vote", "poll.create", "poll.end"]);
const CMDS = new Set(["market", "pool", "wager", "bounty", "stash", "loan", "lotto", "avatar"]);

const clean = (s, n = 300) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
const safeBack = (b) => (/^\/[A-Za-z0-9/_?=&.%-]*$/.test(String(b || "")) && !String(b).startsWith("//") ? String(b) : "/");

/** The signed-in user's last `limit` actions for one page (tag). */
async function recentFor(userId, tag, limit = 8) {
  if (!userId) return [];
  await ready;
  return getQuery("SELECT * FROM pepe_actions WHERE user_id = ? AND tag = ? ORDER BY id DESC LIMIT ?", [userId, tag, limit]);
}

/** Store one action for a user (also used by other modules). Returns the new id or throws. */
async function queue(userId, { kind, args, tag, label }) {
  await ready;
  const u = (await getQuery("SELECT username, camfrogUsername, class FROM users WHERE userId = ?", [userId]))[0];
  if (!u) throw new Error("no account");
  // The "busy" cap is for things a user starts; internal notices (kind "notify", e.g. shop order
  // PMs) neither count towards it nor get dropped by it.
  if (kind !== "notify") {
    const open = await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE user_id = ? AND status IN ('pending','claimed') AND kind != 'notify'", [userId]);
    if (open[0].n >= 6) throw new Error("busy");
  }
  const r = await runQuery(`INSERT INTO pepe_actions (user_id, username, camfrog, site_admin, kind, args, tag, label, status, created, updated)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [userId, u.username, u.camfrogUsername || null, u.class === "Admin" ? 1 : 0, kind, JSON.stringify(args),
     tag || null, clean(label, 200) || null, Date.now(), Date.now()]);
  return r && r.lastID;
}

function register(app, { isBotToken, addUser }) {
  app.post("/act", addUser, async (req, res) => {
    const b = req.body || {};
    const back = safeBack(b.back);
    const go = (msg) => res.redirect(back + (back.includes("?") ? "&" : "?") + "msg=" + encodeURIComponent(msg));
    if (!req.user || !req.user.userId) return res.redirect("/login");
    const kind = String(b.kind || "cmd");
    if (!KINDS.has(kind)) return go("That can't be done from the site.");
    const words = [];
    for (let i = 0; i < 20; i++) {
      const v = clean(b["a" + i]);
      if (v) words.push(v);
    }
    let args;
    if (kind === "cmd") {
      const cmd = String(b.cmd || "");
      if (!CMDS.has(cmd)) return go("That can't be done from the site.");
      if (!words.length) return go("Fill in the form first.");
      args = [cmd, ...words];
    } else {
      args = words;
    }
    const tag = clean(b.tag, 40) || back.split(/[/?]/)[1] || "home";
    const label = clean(b.label || (kind === "cmd" ? "!" + args.join(" ") : kind + " " + words.join(" ")), 200);
    try {
      await queue(req.user.userId, { kind, args, tag, label });
      go("Sent to Pepe — the result shows below in a few seconds.");
    } catch (e) {
      go(e.message === "busy" ? "You already have a few things waiting — give Pepe a moment."
        : e.message === "no account" ? "Couldn't find your account." : "Something went wrong — nothing was sent.");
    }
  });

  // Pepe takes pending actions (and claimed ones he never answered)
  app.post("/api/actions/claim", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    await ready;
    const now = Date.now();
    const rows = await getQuery(`SELECT * FROM pepe_actions WHERE kind != 'table' AND (status = 'pending' OR (status = 'claimed' AND claimed < ?))
                                 ORDER BY id LIMIT 20`, [now - RECLAIM_MS]);
    for (const a of rows) await runQuery("UPDATE pepe_actions SET status = 'claimed', claimed = ?, updated = ? WHERE id = ?", [now, now, a.id]);
    // tells Pepe to wake his table fast lane (tables.js) when no table is open yet, e.g. a web "start"
    const tp = await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'table' AND status = 'pending'");
    res.json({ tablePending: tp[0] ? tp[0].n : 0, actions: rows.map((a) => {
      let args = [];
      try { args = JSON.parse(a.args); } catch (e) { args = []; }
      return { id: a.id, kind: a.kind, args, username: a.username, camfrog: a.camfrog, site_admin: !!a.site_admin };
    }) });
  });

  app.post("/api/actions/ack", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    await ready;
    for (const r of ((req.body || {}).results || []).slice(0, 50)) {
      await runQuery("UPDATE pepe_actions SET status = ?, message = ?, updated = ? WHERE id = ?",
        [r.ok ? "done" : "failed", String(r.message || "").slice(0, 400), Date.now(), parseInt(r.id, 10) || 0]);
    }
    res.json({ ok: true });
  });
}

module.exports = { register, recentFor, queue };
