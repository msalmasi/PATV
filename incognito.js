// incognito.js — Pepe's !incognito from the website too (1.99wa): Settings → Privacy (/settings/privacy).
//
// !incognito is Pepe's switch (pepe_incognito.py): while it's on for a chat login, Pepe remembers nothing new that person says
// (room, PMs, DMs) and the website treats them as "someone" (live room view, captures, quotes, AI cam references, profile
// analytics words). Pepe owns the state; this module only ASKS and SHOWS:
//
//   POST /api/privacy/incognito {on}       the signed-in member's request (same-site fetch). Needs a linked chat login (Camfrog
//                                          today). Queued as a Pepe website action "privacy.incognito" [on|off] (actions.js) -
//                                          Pepe runs the same code path as the chat command for the linked login. Audit row
//                                          "request"; at most RATE_MAX requests per RATE_WINDOW_MS per account (429).
//   GET  /api/privacy/incognito            the member's state AS PEPE LAST REPORTED IT + `waiting` while a request has no report
//                                          newer than it yet (the page shows "Waiting for Pepe…") + the recent audit rows
//   POST /api/privacy/incognito/sync       Pepe (bot token): {items: [{login, on, via: chat|web, changed, ts}], full?: [logins on]}.
//                                          Only LINKED logins are stored. Each reported change files an audit row "applied" and,
//                                          when it really changed, an inbox notice (ref incog:<login>:<ts>: once). `full` heals the
//                                          table: listed linked logins on, every other stored one off.
//   GET  /settings/privacy                 the page (views/privacy-settings.ejs, public/js/privacy-settings.js)
//
// 1.99xa: an account with NO chat login has a chat identity too - the account key "u:<userId>" its web-relay lines are logged
// and remembered under (camfrog-bot pepe_relay / pepe_acctactor). While a Pepe that understands it runs (actorcap.relayOn) the
// switch works for that key exactly like a login's: the same action, the same report, stored under "u:<userId>". Once the
// account links a chat login, the login is its identity again (the key's row stays as history).
//
//   incognito_state   login (lower, PK), on, updated (Pepe's ms of the change), reported (when the site heard it), via
//   incognito_log     id, user_id, login, at, kind request|applied|refused, on, via, ip
//   incognito_meta    key/value: last_full (when Pepe last sent the whole list)
//   incognito_anon    login (lower, PK), since - 1.99wg: every login Pepe reports on, linked or not, only so public game boards
//                     (gtfboards.js) show them as "someone"
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const RATE_MAX = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const WAIT_MS = 15 * 60 * 1000;          // a request older than this with no report is no longer "waiting"
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const ACCT_RE = /^u:([A-Za-z0-9-]{6,64})$/;              // 1.99xa: an account with no chat login (see the top)
const isKey = (l) => LOGIN_RE.test(l) || ACCT_RE.test(l);

let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().replace(/^@/, "").toLowerCase();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS incognito_state (login TEXT PRIMARY KEY, "on" INTEGER NOT NULL DEFAULT 0, updated INTEGER,
        reported INTEGER, via TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS incognito_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, login TEXT, at INTEGER NOT NULL,
        kind TEXT NOT NULL, "on" INTEGER, via TEXT, ip TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS incognito_log_user ON incognito_log (user_id, at)");
      await runQuery("CREATE TABLE IF NOT EXISTS incognito_meta (key TEXT PRIMARY KEY, value TEXT)");
      // 1.99wg: every login Pepe reports incognito, linked or not - ONLY to show them as "someone" on public boards that
      // hold their game records (gtfboards.js: the GTF leaderboards). No account, no audit, no notice for these.
      await runQuery("CREATE TABLE IF NOT EXISTS incognito_anon (login TEXT PRIMARY KEY, since INTEGER)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function log(e) {
  try {
    await runQuery(`INSERT INTO incognito_log (user_id, login, at, kind, "on", via, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [e.userId ? String(e.userId) : null, e.login ? String(e.login).slice(0, 64) : null, e.at || now(), e.kind,
       e.on == null ? null : e.on ? 1 : 0, e.via ? String(e.via).slice(0, 12) : null, e.ip ? String(e.ip).slice(0, 64) : null]);
  } catch (err) { console.error("[incognito] log:", err.message); }
}

async function hasArchived() {
  try { return (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at"); } catch (e) { return false; }
}
/** The live account a chat login is linked to, or null. */
async function userByLogin(login) {
  const l = low(login);
  const m = ACCT_RE.exec(String(login == null ? "" : login).trim());
  if (m) {
    return (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE userId = ? AND (camfrogUsername IS NULL OR camfrogUsername = '')
                            ${(await hasArchived()) ? "AND archived_at IS NULL" : ""}`, [m[1]]))[0] || null;
  }
  if (!l || !LOGIN_RE.test(l)) return null;
  return (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE lower(camfrogUsername) = ? ${(await hasArchived()) ? "AND archived_at IS NULL" : ""}
                          LIMIT 1`, [l]))[0] || null;
}
async function loginOf(userId) {
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  if (!r) return null;
  const l = low(r.camfrogUsername);
  if (l) return LOGIN_RE.test(l) ? l : null;
  // 1.99xa: no chat login -> the account key, while a Pepe that honours it runs (or once he has reported on it)
  const key = "u:" + String(userId);
  if (!ACCT_RE.test(key)) return null;
  if (require("./actorcap").relayOn()) return key;
  const had = (await getQuery("SELECT 1 AS x FROM incognito_state WHERE login = ?", [key]))[0];
  return had ? key : null;
}
async function lastFull() {
  const r = (await getQuery("SELECT value FROM incognito_meta WHERE key = 'last_full'"))[0];
  return r ? Number(r.value) || null : null;
}

/** The member's incognito as Pepe reported it. {linked, login, on (null = Pepe hasn't reported yet), updated, reported,
 *  waiting: {id, want, status} | null, failed: {message} | null, log: [...]} */
async function stateOf(userId) {
  await init();
  const login = await loginOf(userId);
  const out = { linked: !!login, login, account: !!(login && ACCT_RE.test(login)), on: null, updated: null, reported: null, waiting: null,
                failed: null, log: [] };
  if (out.account) {
    const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [String(userId)]))[0];
    out.name = u ? u.username : null;
  }
  out.log = await getQuery(`SELECT at, kind, "on" AS "on", via FROM incognito_log WHERE user_id = ? AND kind IN ('request', 'applied', 'refused')
                            ORDER BY id DESC LIMIT 8`, [String(userId)]);
  if (!login) return out;
  const r = (await getQuery(`SELECT "on" AS "on", updated, reported FROM incognito_state WHERE login = ?`, [login]))[0];
  const full = await lastFull();
  if (r) { out.on = !!r.on; out.updated = Number(r.updated) || null; out.reported = Number(r.reported) || null; }
  else if (full) { out.on = false; out.reported = full; }
  // the newest request: waiting until Pepe's report of a change is newer than it (or it failed / expired / got too old)
  let a = null;
  try {
    a = (await getQuery(`SELECT id, args, status, message, created, updated FROM pepe_actions WHERE user_id = ? AND kind = 'privacy.incognito'
                         ORDER BY id DESC LIMIT 1`, [String(userId)]))[0] || null;
  } catch (e) { a = null; }
  if (a) {
    let want = null;
    try { want = JSON.parse(a.args)[0] === "on"; } catch (e) { want = null; }
    const answered = out.updated && out.updated >= Number(a.created);
    if (a.status === "failed" || a.status === "expired") {
      if (Date.now() - Number(a.updated || a.created) < WAIT_MS) out.failed = { message: a.message || "" };
    } else if (!answered && Date.now() - Number(a.created) < WAIT_MS) {   // pepe_actions rows carry real time
      out.waiting = { id: a.id, want, status: a.status };
    }
  }
  return out;
}

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code; } }

/** The member asks Pepe to turn incognito on/off. -> {id} (the action) | throws Refuse. */
async function request(userId, on, { ip } = {}) {
  await init();
  if (typeof on !== "boolean") throw new Refuse(400, "on must be true or false", "bad");
  const login = await loginOf(userId);
  if (!login) throw new Refuse(409, "Link your chat account first - incognito is about your chat identity.", "unlinked");
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM incognito_log WHERE user_id = ? AND kind = 'request' AND at > ?",
                                 [String(userId), now() - RATE_WINDOW_MS]))[0].n;
  if (recent >= RATE_MAX) {
    await log({ userId, login, kind: "refused", on, via: "web", ip });
    throw new Refuse(429, "That's a lot of switching - try again in a while.", "rate");
  }
  let id;
  try {
    id = await require("./actions").queue(String(userId), { kind: "privacy.incognito", args: [on ? "on" : "off"], tag: "privacy",
                                                            label: `incognito ${on ? "on" : "off"}` });
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.", "busy");
    throw e;
  }
  await log({ userId, login, kind: "request", on, via: "web", ip });
  return { id };
}

/** Pepe's report. -> {applied, ignored} */
async function sync(body) {
  await init();
  const items = Array.isArray(body && body.items) ? body.items.slice(0, 500) : [];
  let applied = 0, ignored = 0;
  const t = now();
  for (const it of items) {
    const login = low(it && it.login);
    const ts = Math.floor(Number(it && it.ts) || 0);
    if (!login || !isKey(login) || !(ts > 0)) { ignored++; continue; }
    if (it.on === true) await runQuery("INSERT INTO incognito_anon (login, since) VALUES (?, ?) ON CONFLICT(login) DO NOTHING", [login, t]);
    else await runQuery("DELETE FROM incognito_anon WHERE login = ?", [login]);
    const u = await userByLogin(login);
    if (!u) { ignored++; continue; }                       // only linked chat identities are kept
    const on = it.on === true;
    const via = it.via === "web" ? "web" : "chat";
    const cur = (await getQuery(`SELECT "on" AS "on", updated FROM incognito_state WHERE login = ?`, [login]))[0];
    if (cur && Number(cur.updated) > ts) { ignored++; continue; }   // an older report than what we have
    await runQuery(`INSERT INTO incognito_state (login, "on", updated, reported, via) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(login) DO UPDATE SET "on" = excluded."on", updated = excluded.updated, reported = excluded.reported, via = excluded.via`,
                   [login, on ? 1 : 0, ts, t, via]);
    await log({ userId: u.userId, login, kind: "applied", on, via, at: t });
    applied++;
    if (it.changed !== false) {
      const where = via === "web" ? "from Settings → Privacy" : "with !incognito in chat";
      const who = ACCT_RE.test(login) ? "your PATV account (what you say in pad chat rooms from the website)" : `your chat name ${login}`;
      await require("./inbox").addSafe(u.userId, {
        kind: "system",
        title: on ? "🕶️ Incognito is on" : "🕶️ Incognito is off",
        body: on
          ? `Pepe switched incognito ON for ${who} (${where}). He won't remember anything new you say, and the website shows you as "someone". Not you? Turn it off in Settings → Privacy.`
          : `Pepe switched incognito OFF for ${who} (${where}). He remembers what you tell him again, and the website shows your name. Not you? Turn it back on in Settings → Privacy.`,
        link: "/settings/privacy", ref: `incog:${login}:${ts}` });
    }
  }
  if (Array.isArray(body && body.full)) {
    const set = new Set(body.full.map(low).filter(isKey));
    for (const r of await getQuery("SELECT login FROM incognito_anon")) if (!set.has(r.login)) await runQuery("DELETE FROM incognito_anon WHERE login = ?", [r.login]);
    for (const l of set) await runQuery("INSERT INTO incognito_anon (login, since) VALUES (?, ?) ON CONFLICT(login) DO NOTHING", [l, t]);
    // stored logins that are no longer on the list -> off
    for (const r of await getQuery(`SELECT login FROM incognito_state WHERE "on" = 1`)) {
      if (!set.has(r.login)) await runQuery(`UPDATE incognito_state SET "on" = 0, reported = ? WHERE login = ?`, [t, r.login]);
    }
    for (const l of set) {
      if (!(await userByLogin(l))) continue;
      await runQuery(`INSERT INTO incognito_state (login, "on", updated, reported, via) VALUES (?, 1, NULL, ?, 'full')
                      ON CONFLICT(login) DO UPDATE SET "on" = 1, reported = excluded.reported`, [l, t]);
    }
    await runQuery("INSERT INTO incognito_meta (key, value) VALUES ('last_full', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(t)]);
  }
  return { applied, ignored };
}

function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[incognito] init:", e.message));
  const guard = require("./middleware/authGuard");
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
    console.error("[incognito]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.post("/api/privacy/incognito/sync", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try { res.json({ ok: true, ...(await sync(b)) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/privacy/incognito", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await stateOf(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/privacy/incognito", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await request(req.user.userId, (req.body || {}).on, { ip: guard.clientIp(req) })) }); } catch (e) { fail(res, e); }
  });
  app.get("/settings/privacy", addUser, async (req, res, next) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings/privacy"));
      res.set("Cache-Control", "private, no-store");
      // 1.99yh: + the 📡 live-cam switch (livecam.js owns it; the card is here - one privacy page)
      let lc = null;
      try { lc = await require("./livecam").optoutState(req.user.userId); } catch (e) { lc = null; }
      res.render("privacy-settings", { user: req.user.username, st: await stateOf(req.user.userId), lc });
    } catch (e) { next(e); }
  });
}

module.exports = { init, register, request, sync, stateOf, RATE_MAX, RATE_WINDOW_MS, Refuse, _setClock: (f) => { clock = f; } };
