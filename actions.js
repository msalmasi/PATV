// actions.js — doing things in Pepe's games from the website (1.90).
//
// A signed-in user submits a form; we store it as an action and Pepe claims pending actions every
// few seconds, runs each AS that user through the same chat command (so every rule and fee is the
// same as in a room), and acks with what he would have replied. Pages show the user's recent actions
// with that reply. 1.99wv (connections audit C): each claimed action carries the account as its `actor` ({userId,
// username, login, display}); Pepe acts as the linked chat login, else as the account itself ("u:<userId>", camfrog-bot
// pepe_acctactor.py). Which forms an account with no chat login sees depends on actorcap.on() (a capable Pepe).
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
//   pad    (1.99ur) market / pool "new" and poll.create: the pad it's for (padlinks.checkPick: one the user can see; "" =
//          site-wide). Sent on as the word pad:<id> (pad:none = site-wide), which Pepe's and the site's parsers read.
//   until, tz  (1.99ur) market / pool "new": a picked close (unix seconds, from the form's date/time in the browser's zone)
//          and that zone. Checked against the admins' bounds (mktcfg.js) here, then sent on as until:<s> tz:<zone>.
//   idem   (1.99bj) a one-time key per submission, added to every /act form by views/partials/actions.ejs;
//          the same key twice is one submission (refused here, and Pepe journals it too)
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

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
const N = require("./notices");         // 1.99ade: the notice the page shows after a form (?m=<id>, never ?msg=<text>)
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
  // PMs) neither count towards it nor get dropped by it. 1.99acm: nor is a "Make Pepe forget me"
  // (privacy.forgetme) - a privacy request never depends on Pepe's queue having room (pepeforget.js
  // rate-limits it to 3 a day); it still counts towards the cap for everything else.
  if (kind !== "notify" && kind !== "privacy.forgetme") {
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
      [userId, u.username, u.camfrogUsername || null, SP.can(u, "escrow.override") ? 1 : 0, kind, JSON.stringify(args),
       tag || null, clean(label, 200) || null, Date.now(), Date.now(), key]);
  } catch (e) {
    if (key && /UNIQUE/i.test(String(e && e.message))) throw new Error("duplicate");   // lost a race with its twin
    throw e;
  }
  return r && (r.id || r.lastID);   // dbUtils.runQuery resolves {id, changes}
}

// ── 1.99ade: the item a form names, and whether this member may see it ──
// The verbs whose next word is the item (the engines' fromForm and Pepe's commands); otherwise a lone first word is a read
// ("pool M5", "bounty BT8", "wager W3") - pools / markets also take the item first for a bet ("M5 yes 1k").
const REF_VERBS = {
  m: new Set(["bet", "back", "buy", "sell", "settle", "resolve", "cancel", "void", "ai", "dispute", "judge", "close", "info", "show", "view", "odds", "status"]),
  bt: new Set(["add", "chip", "contribute", "+", "claim", "done", "did", "resolve", "pay", "award", "cancel", "withdraw", "void", "reject", "deny",
               "dispute", "appeal", "verify", "check", "spec", "info", "show", "view", "status"]),
  w: new Set(["accept", "decline", "cancel", "settle", "resolve", "judge", "ai", "dispute", "info", "show", "view", "status"]),
};
const REF_RE = { m: /^#?m?(\d{1,9})$/i, bt: /^#?(?:bt)?(\d{1,9})$/i, w: /^#?w?(\d{1,9})$/i };
const CMD_KIND = { pool: "m", market: "m", bounty: "bt", wager: "w" };
/** The id of the item a form's words name (cmd: pool | market | bounty | wager), or null (a create / list / no item). */
function refOf(cmd, words) {
  const k = CMD_KIND[cmd];
  if (!k) return null;
  const w = words.map((x) => String(x || "").trim());
  const first = w[0].toLowerCase();
  let cand = null;
  if (REF_VERBS[k].has(first)) cand = w[1];
  else if (k === "m" ? !/^(new|create|list|ls|help|mine)$/.test(first) : w.length === 1) cand = w[0];
  const m = cand ? REF_RE[k].exec(cand) : null;
  return m ? { kind: k, id: parseInt(m[1], 10) } : null;
}
/**
 * The notice key when the item a form names is missing or on a pad `user` can't see (market / pool and bounty: the pad rule
 * of their pages; a wager: its room's pad, unless the member is one of its parties or its judge, /wagers' rule) - else null.
 */
async function refMissing(user, cmd, words) {
  const r = refOf(cmd, words);
  if (!r) return null;
  const KEY = { m: "mkt_missing", bt: "bty_missing", w: "wgr_missing" }[r.kind];
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const escrow = async (game) => { try { return await require("./escrow/games").load(game, r.id); } catch (e) { return null; } };
  const padlinks = require("./padlinks"), PA = require("./padaccess");
  try { await padlinks.ready(); await PA.init(); } catch (e) { return KEY; }          // can't tell: refuse
  const sees = (pad) => { try { return !pad || PA.canSee(user || null, pad); } catch (e) { return false; } };
  try {
    if (r.kind === "m") {
      const row = (await getQuery("SELECT data, pad FROM markets WHERE id = ?", [r.id]).catch(() => []))[0];
      const rec = row ? parse(row.data) : await escrow("pools");
      if (!rec) return KEY;
      return sees((row && row.pad) || padlinks.resolve(rec) || null) ? null : KEY;
    }
    if (r.kind === "bt") {
      const row = (await getQuery("SELECT data FROM bounties WHERE id = ?", [r.id]).catch(() => []))[0];
      const rec = row ? parse(row.data) : await escrow("bounties");
      if (!rec) return KEY;
      return sees(padlinks.resolve({ room: rec.room }) || null) ? null : KEY;
    }
    const row = (await getQuery("SELECT data FROM wagers WHERE id = ?", [r.id]).catch(() => []))[0];
    const rec = row ? parse(row.data) : await escrow("wagers");
    if (!rec) return KEY;
    if (sees(padlinks.resolve({ pad: rec.pad, room: rec.room }) || null)) return null;
    const me = (await getQuery("SELECT username, camfrogUsername FROM users WHERE userId = ?", [user && user.userId]))[0] || {};
    const same = require("./escrow/games").same;
    const mine = [me.camfrogUsername, me.username].filter(Boolean);
    return [rec.creator, rec.opponent, rec.ai_judge ? null : rec.judge].some((n) => mine.some((x) => same(x, n))) ? null : KEY;
  } catch (e) {
    console.error("[act] item check:", e.message);
    return KEY;
  }
}

// ── PO-0b (D-6): economy actions carry the owner check, never the Admin class ──
const isEconKind = (k) => /^econ\./.test(String(k || ""));
/** For an econ.* action: {is_owner, login} - the account's linked chat login NOW, and whether it is a Pepe owner with the
 *  action's capability (staffroles.ownerOf). The login must still be the one the action was queued with (Pepe acts as it). */
async function econOwner(a) {
  try {
    const SR = require("./staffroles");
    const me = await SR.ownerOf({ userId: a.user_id }, a.kind === "econ.burn" ? "econ.burn" : "econ.pepe_econ_cmds");
    const login = me && me.camfrogUsername ? String(me.camfrogUsername).trim().toLowerCase() : null;
    const same = !!login && login === String(a.camfrog || "").trim().toLowerCase();
    return { is_owner: !!me && same, login: login || (a.camfrog ? String(a.camfrog).trim().toLowerCase() : null) };
  } catch (e) {
    console.error("[actions] owner check:", e.message);
    return { is_owner: false, login: null };
  }
}

function register(app, { isBotToken, addUser }) {
  app.post("/act", addUser, async (req, res) => {
    const b = req.body || {};
    const back = safeBack(b.back);
    // 1.99ade: back to the page with ?m=<id> (notices.js) - a catalog key (N.K) or an engine's reply held for this account;
    // never ?msg=<text>, which let anyone link a site page "saying" anything
    const go = (msg) => res.redirect(N.href(req, back, msg));
    if (!req.user || !req.user.userId) return res.redirect("/login");
    const kind = String(b.kind || "cmd");
    if (!KINDS.has(kind)) return go(N.K("act_cant"));
    const words = [];
    for (let i = 0; i < 20; i++) {
      const v = clean(b["a" + i]);
      if (v) words.push(v);
    }
    let args;
    if (kind === "cmd") {
      const cmd = String(b.cmd || "");
      if (!CMDS.has(cmd)) return go(N.K("act_cant"));
      if (!words.length) return go(N.K("act_fill"));
      args = [cmd, ...words];
    } else {
      args = words;
    }
    // 1.99ur: the create forms' pad picker + a picked close date (markets / pools / polls)
    const creating = (kind === "cmd" && (args[0] === "market" || args[0] === "pool") && /^(new|create)$/i.test(String(args[1] || "")))
      || kind === "poll.create";
    let padPick = null;
    if (creating && b.pad !== undefined) {
      padPick = await require("./padlinks").checkPick(req.user, b.pad);
      if (padPick === null) return go(N.K("act_pad"));
    }
    if (creating && kind === "cmd") {
      const until = Math.floor(Number(b.until) || 0);
      if (until) {
        const secs = until - Math.floor(Date.now() / 1000);
        const bad = args[0] === "market" ? await require("./mktcfg").checkClose(secs)
          : secs < 300 || secs > 30 * 86400 ? "Betting can stay open from 5 minutes to 30 days." : null;
        if (bad) return go(bad);
        args = args.filter((w, i) => i < 2 || !/^closes?\s/i.test(w));       // the picked date replaces the duration
        args.push("until:" + until);
        const tz = require("./markets").cleanTz(b.tz);
        if (tz) args.push("tz:" + tz);
      }
      if (padPick !== null) args.push("pad:" + (padPick || "none"));
    }
    // 1.99ade: a form naming a market / pool, a bounty or a wager this member may not see (an Approved pad's, padaccess) -
    // or one that doesn't exist - answers "doesn't exist", the same both ways, before anything runs or is queued: the engines'
    // replies ("M12 options are: ...", "the pot is PAT X now") and Pepe's read replies confirmed it and told what's in it
    if (kind === "cmd" && !creating) {
      const missing = await refMissing(req.user, args[0], args.slice(1));
      if (missing) return go(N.K(missing));
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
        return go(N.K("err_bought"));
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
        return go(N.K("err_moved"));
      }
    }
    // Phase 3: with the capital cluster on the site (capital/*), a vault stake / unstake and a Federal Reserve loan form run here
    // directly - nothing is sent to Pepe (a P2P loan form falls through to the escrow game below)
    if (kind === "cmd" && (args[0] === "stash" || args[0] === "loan")) {
      try {
        const msg = args[0] === "stash" ? await require("./capital/service").stashForm(req.user.userId, args.slice(1))
          : (await require("./capital/core").live()) ? await require("./capital/reserve").fromForm(req.user.userId, args.slice(1)) : null;
        if (msg) return go(msg);
      } catch (e) {
        console.error(`[act] capital ${args[0]}:`, e.message);
        return go(N.K("err_changed"));
      }
    }
    // 1.99ou Phase 2: with an escrow game on the site (escrow/games.js), its form runs here directly - nothing is sent to Pepe
    if (kind === "cmd" && ["wager", "bounty", "pool", "loan"].includes(args[0])) {
      try {
        const msg = await require("./escrow/games").fromForm(req.user.userId, args[0], args.slice(1), b.idem);
        if (msg) return go(msg);
      } catch (e) {
        console.error(`[act] escrow ${args[0]}:`, e.message);
        return go(N.K("err_changed"));
      }
    }
    // 1.99ns: with the polls on the site (polls.js backend), a poll form is done here directly - nothing is sent to Pepe
    if (kind.startsWith("poll.")) {
      try {
        const msg = await require("./polls").fromForm(req.user.userId, kind, words, { pad: padPick });
        if (msg) return go(msg);
      } catch (e) {
        console.error("[act] polls backend:", e.message);
        return go(N.K("err_changed"));
      }
    }
    const tag = clean(b.tag, 40) || back.split(/[/?]/)[1] || "home";
    const label = clean(b.label || (kind === "cmd" ? "!" + args.join(" ") : kind + " " + words.join(" ")), 200);
    try {
      await queue(req.user.userId, { kind, args, tag, label, idem: b.idem, dedupe: true });
      go(N.K("act_sent"));
    } catch (e) {
      go(N.K(e.message === "duplicate" ? "act_dup" : e.message === "busy" ? "act_busy" : e.message === "no account" ? "no_account" : "err_sent"));
    }
  });

  // Pepe takes pending actions (and claimed ones he never answered)
  app.post("/api/actions/claim", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    require("./actorcap").note(req.body);        // 1.99wv: a Pepe that acts for accounts says so (actorcap.js)
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
    const owner = {};
    for (const a of rows) if (isEconKind(a.kind)) owner[a.id] = await econOwner(a);
    res.json({ tablePending: tp[0] ? tp[0].n : 0, actions: rows.map((a) => {
      let args = [];
      try { args = JSON.parse(a.args); } catch (e) { args = []; }
      const econ = isEconKind(a.kind);
      const o = econ ? owner[a.id] : null;
      // 1.99wv (connections audit C): the ACCOUNT is the actor - Pepe acts as its chat login, else as "u:<userId>"
      // PO-0b (D-6): an economy action (econ.*: !econ from /admin/economy, routing, a burn) no longer rides on the Admin
      // class: site_admin is the site-computed is_owner (the class AND Pepe's owner role on the linked login, read now), so a
      // Pepe before PO-0c still runs an owner's and refuses everyone else's; is_owner + login are sent for his own check
      return { id: a.id, kind: a.kind, args, username: a.username, camfrog: a.camfrog, site_admin: econ ? !!(o && o.is_owner) : !!a.site_admin,
               is_owner: !!(o && o.is_owner), login: econ ? (o && o.login) || null : a.camfrog || null, idem: a.idem || null,
               user_id: a.user_id, actor: { userId: a.user_id, username: a.username, login: a.camfrog || null, display: null },
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
    // 1.99add: a website Incognito ON he answered settles the sticky hidden set (incognito.actionsSettled; never rejects)
    const acked = ((req.body || {}).results || []).slice(0, 50).map((r) => r && r.id);
    if (acked.length) await require("./incognito").actionsSettled(acked);
    res.json({ ok: true });
  });
}

module.exports = { register, recentFor, queue };
