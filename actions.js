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
//   cmd    for kind=cmd: market | pool | wager | bounty | stash | loan | lotto | donate
//   a0..a19  the words, in order (empty ones are skipped). For kind=cmd they're joined into the
//          command's arguments, e.g. cmd=wager a0=@bob a1=10k a2="Lakers win" a3=judge a4=@carol
//   back   the page to return to (a local path)
//   tag    which page's activity list this belongs to (defaults to the first part of `back`)
//   idem   (1.99bj) a one-time key per submission, added to every /act form by views/partials/actions.ejs;
//          the same key twice is one submission (refused here, and Pepe journals it too)
const { runQuery, getQuery } = require("./dbUtils");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS pepe_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT NOT NULL, camfrog TEXT,
  site_admin INTEGER DEFAULT 0, kind TEXT NOT NULL, args TEXT NOT NULL, tag TEXT, label TEXT,
  status TEXT NOT NULL DEFAULT 'pending', message TEXT, created INTEGER, claimed INTEGER, updated INTEGER)`).catch(() => {})
  // 1.99bj: a one-time key per form submission (idempotency). An existing table gets the column; the
  // unique index makes a second row with the same (user, key) impossible, even for two racing posts.
  .then(() => runQuery("ALTER TABLE pepe_actions ADD COLUMN idem TEXT").catch(() => {}))
  .then(() => runQuery("CREATE UNIQUE INDEX IF NOT EXISTS pepe_actions_idem ON pepe_actions (user_id, idem)").catch(() => {}))
  // 1.99ep: a failure's stable error code + hint (weberrors.js) and, for E_INTERNAL, Pepe's incident id
  .then(() => runQuery("ALTER TABLE pepe_actions ADD COLUMN code TEXT").catch(() => {}))
  .then(() => runQuery("ALTER TABLE pepe_actions ADD COLUMN hint TEXT").catch(() => {}))
  .then(() => runQuery("ALTER TABLE pepe_actions ADD COLUMN incident TEXT").catch(() => {}));
const weberrors = require("./weberrors");
const ttl = require("./actionttl");     // 1.99ne: queued actions expire
const RECLAIM_MS = 2 * 60 * 1000;
const KINDS = new Set(["cmd", "poll.vote", "poll.create", "poll.end"]);
const CMDS = new Set(["market", "pool", "wager", "bounty", "stash", "loan", "lotto", "avatar", "sheet", "donate"]);   // 1.99rn: sheet = the web "Re-roll sheet" (regen only, Pepe refuses the rest)

const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;
const clean = (s, n = 300) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
const safeBack = (b) => (/^\/[A-Za-z0-9/_?=&.%-]*$/.test(String(b || "")) && !String(b).startsWith("//") ? String(b) : "/");

/** The signed-in user's last `limit` actions for one page (tag). 1.99ep: a failed one carries `err`
 *  (weberrors.present: {code, message, hint, incident}) - what views/partials/actions.ejs shows. */
async function recentFor(userId, tag, limit = 8) {
  if (!userId) return [];
  await ready;
  const rows = await getQuery("SELECT * FROM pepe_actions WHERE user_id = ? AND tag = ? ORDER BY id DESC LIMIT ?", [userId, tag, limit]);
  for (const a of rows) a.err = weberrors.present(a);
  return rows;
}

/** Store one action for a user (also used by other modules). Returns the new id or throws
 *  ("busy", "no account", "duplicate"). 1.99bj: `idem` is the form's one-time key - the same key twice
 *  is the same submission (a double click, a resubmitted page) and is refused; and with `dedupe` (the
 *  /act forms) an identical action (same kind + words) still waiting for Pepe isn't queued again. */
async function queue(userId, { kind, args, tag, label, idem, dedupe }) {
  await ready;
  const u = (await getQuery("SELECT username, camfrogUsername, class FROM users WHERE userId = ?", [userId]))[0];
  if (!u) throw new Error("no account");
  // The "busy" cap is for things a user starts; internal notices (kind "notify", e.g. shop order
  // PMs) neither count towards it nor get dropped by it.
  if (kind !== "notify") {
    const open = await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE user_id = ? AND status IN ('pending','claimed') AND kind != 'notify'", [userId]);
    if (open[0].n >= 6) throw new Error("busy");
  }
  const key = IDEM_RE.test(String(idem || "")) ? String(idem) : null;
  if (key) {
    const seen = await getQuery("SELECT id FROM pepe_actions WHERE user_id = ? AND idem = ?", [userId, key]);
    if (seen.length) throw Object.assign(new Error("duplicate"), { actionId: seen[0].id });
  }
  if (dedupe && kind !== "notify") {
    const same = await getQuery(`SELECT id FROM pepe_actions WHERE user_id = ? AND kind = ? AND args = ?
                                 AND status IN ('pending','claimed') LIMIT 1`, [userId, kind, JSON.stringify(args)]);
    if (same.length) throw Object.assign(new Error("duplicate"), { actionId: same[0].id });
  }
  let r;
  try {
    r = await runQuery(`INSERT INTO pepe_actions (user_id, username, camfrog, site_admin, kind, args, tag, label, status, created, updated, idem)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [userId, u.username, u.camfrogUsername || null, u.class === "Admin" ? 1 : 0, kind, JSON.stringify(args),
       tag || null, clean(label, 200) || null, Date.now(), Date.now(), key]);
  } catch (e) {
    if (key && /UNIQUE/i.test(String(e && e.message))) throw new Error("duplicate");   // lost a race with its twin
    throw e;
  }
  return r && (r.id || r.lastID);   // dbUtils.runQuery resolves {id, changes}
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
    // 1.99ml: with the lotto backend on, a lotto form buys on the site directly - nothing is sent to Pepe
    if (kind === "cmd" && args[0] === "lotto") {
      try {
        const msg = await require("./lotto/routes").buyFromForm(req.user.userId, args.slice(1), b.idem, { confirm: String(b.confirm || "") === "1" });
        // 1.99nh: a hand pick the buyer already holds this draw - nothing charged; the page asks "buy it again?"
        if (msg && typeof msg === "object" && msg.confirm) {
          const c = msg.confirm;
          return res.redirect(back + (back.includes("?") ? "&" : "?") + "dup=" + encodeURIComponent([...c.w, c.pb].join("-"))
                              + "&dupdraw=" + encodeURIComponent(String(c.draw)) + "#pb-dup");
        }
        if (msg) return go(typeof msg === "object" ? msg.msg : msg);
      } catch (e) {
        console.error("[act] lotto backend:", e.message);
        return go("Something went wrong — nothing was bought.");
      }
    }
    // 1.99ne: with the stashes on the site, a stash form (create / deposit / withdraw / members / rename / close) runs
    // here directly - with or without Pepe. Vault stake / unstake stay Pepe's (null -> queued below).
    if (kind === "cmd" && args[0] === "stash") {
      try {
        const msg = await require("./stashes").fromForm(req.user.userId, args.slice(1), b.idem);
        if (msg) return go(msg);
      } catch (e) {
        console.error("[act] stash backend:", e.message);
        return go("Something went wrong — nothing was moved.");
      }
    }
    // 1.99ou Phase 2: with an escrow game on the site (escrow/games.js), its form runs here directly - nothing is sent to Pepe
    if (kind === "cmd" && ["wager", "bounty", "pool", "loan"].includes(args[0])) {
      try {
        const msg = await require("./escrow/games").fromForm(req.user.userId, args[0], args.slice(1), b.idem);
        if (msg) return go(msg);
      } catch (e) {
        console.error(`[act] escrow ${args[0]}:`, e.message);
        return go("Something went wrong — nothing changed.");
      }
    }
    // 1.99ns: with the polls on the site (polls.js backend), a poll form is done here directly - nothing is sent to Pepe
    if (kind.startsWith("poll.")) {
      try {
        const msg = await require("./polls").fromForm(req.user.userId, kind, words);
        if (msg) return go(msg);
      } catch (e) {
        console.error("[act] polls backend:", e.message);
        return go("Something went wrong — nothing was changed.");
      }
    }
    const tag = clean(b.tag, 40) || back.split(/[/?]/)[1] || "home";
    const label = clean(b.label || (kind === "cmd" ? "!" + args.join(" ") : kind + " " + words.join(" ")), 200);
    try {
      await queue(req.user.userId, { kind, args, tag, label, idem: b.idem, dedupe: true });
      go("Sent to Pepe — the result shows below in a few seconds.");
    } catch (e) {
      go(e.message === "duplicate" ? "Already sent — that one is with Pepe, so it wasn't sent twice. The result shows below."
        : e.message === "busy" ? "You already have a few things waiting — give Pepe a moment."
        : e.message === "no account" ? "Couldn't find your account." : "Something went wrong — nothing was sent.");
    }
  });

  // Pepe takes pending actions (and claimed ones he never answered)
  app.post("/api/actions/claim", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    await ready;
    // 1.99ne: overdue pending rows expire first (actionttl.js) - never handed out late
    await ttl.sweepTable("pepe_actions").catch((e) => console.error("[actions] ttl sweep:", e.message));
    const now = Date.now();
    const found = await getQuery(`SELECT * FROM pepe_actions WHERE kind != 'table' AND (status = 'pending' OR (status = 'claimed' AND claimed < ?))
                                 ORDER BY id LIMIT 20`, [now - RECLAIM_MS]);
    // conditional: a row the TTL sweep expired in between stays expired (and isn't handed out)
    const rows = [];
    for (const a of found) {
      const r = await runQuery(`UPDATE pepe_actions SET status = 'claimed', claimed = ?, updated = ?
                                WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND claimed < ?))`, [now, now, a.id, now - RECLAIM_MS]);
      if (r && r.changes === 1) rows.push(a);
    }
    // tells Pepe to wake his table fast lane (tables.js) when no table is open yet, e.g. a web "start"
    const tp = await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'table' AND status = 'pending'");
    res.json({ tablePending: tp[0] ? tp[0].n : 0, actions: rows.map((a) => {
      let args = [];
      try { args = JSON.parse(a.args); } catch (e) { args = []; }
      return { id: a.id, kind: a.kind, args, username: a.username, camfrog: a.camfrog, site_admin: !!a.site_admin, idem: a.idem || null,
               created: a.created || null, expires_at: ttl.expiresAt("pepe_actions", a) };   // 1.99ne: Pepe won't START it after this
    }) });
  });

  app.post("/api/actions/ack", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    await ready;
    for (const r of ((req.body || {}).results || []).slice(0, 50)) {
      // 1.99ep: a failure carries a stable code (unknown / missing -> inferred from the message), its hint and,
      // for E_INTERNAL, Pepe's incident id; a success clears them (a later follow-up can turn a failure into ok)
      const code = r.ok ? null : (weberrors.CODES.includes(r.code) ? r.code : weberrors.classify(r.message));
      const hint = r.ok ? null : String(r.hint || weberrors.ERRORS[code][1]).slice(0, 300);
      const incident = !r.ok && /^[0-9a-f]{6,16}$/i.test(String(r.incident || "")) ? String(r.incident) : null;
      await runQuery("UPDATE pepe_actions SET status = ?, message = ?, code = ?, hint = ?, incident = ?, updated = ? WHERE id = ?",
        [r.ok ? "done" : "failed", String(r.message || "").slice(0, 400), code, hint, incident, Date.now(), parseInt(r.id, 10) || 0]);
    }
    // 1.99kp: a room.ctl join's password is blanked as soon as Pepe has answered (roomctl.js)
    if (((req.body || {}).results || []).length) require("./roomctl").scrubPasswords().catch(() => {});
    res.json({ ok: true });
  });
}

module.exports = { register, recentFor, queue };
