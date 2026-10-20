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
//
// 1.99acf: the chat hub's privacy cache (huboutbox.js topic privacy/changed, switch hubseam.privacy): a web request writes a
// "requested" row in the same transaction as the action (the hub hides at once on ON; it un-hides only on "confirmed"), and
// every change Pepe reports writes a "confirmed" row - for unlinked logins too. Subject ids only, never any line text.
// 1.99acm: a login reaches the hub only as its hidden hash (entity "cfh:<h>", subject login_h - seam plan D-6), and Pepe's
// full list (`full`) heals in one transaction that also writes a "confirmed" row for every key it turns ON or OFF, so a login
// that is ON only through the full list is hidden on the hub at once, not at the next snapshot.
// 1.99add: Pepe's sticky hidden set (hubhidden.js) hears a website ON at once (provisional) and every report Pepe sends;
// actionsSettled (actions.js's ack, actionttl.js's expiry sweep) and reconcileWeb (start-up) tell it what became of a website
// ON - one Pepe never applied is undone there. 1.99add refix 4: all of that touches only the set's INCOGNITO kind (shown as
// "someone", the words kept - the owner's rule of 2026-10-19); !bridge hide is its own kind (left out). Pepe's `full` list adds to
// it (never removes).
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

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
  // 1.99acm: lower(trim(...)) with the partial index's own terms, so users_camfrog_login (accountMerge.js) answers it - not a scan
  return (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE lower(trim(camfrogUsername)) = ? ${LINKED}
                          ${(await hasArchived()) ? "AND archived_at IS NULL" : ""} LIMIT 1`, [l]))[0] || null;
}
const LINKED = "AND camfrogUsername IS NOT NULL AND trim(camfrogUsername) != ''";
/** 1.99acm: the live accounts of many chat logins in one indexed query (huboutbox's privacy/changed snapshot page). -> Map(login -> userId) */
async function usersByLogins(logins) {
  const want = [...new Set((logins || []).map(low).filter((l) => LOGIN_RE.test(l)))];
  const out = new Map();
  const arch = (await hasArchived()) ? "AND archived_at IS NULL" : "";
  for (let i = 0; i < want.length; i += 400) {
    const part = want.slice(i, i + 400);
    for (const r of await getQuery(`SELECT userId, lower(trim(camfrogUsername)) AS l FROM users WHERE lower(trim(camfrogUsername)) IN (${part.map(() => "?").join(",")})
                                    ${LINKED} ${arch}`, part)) {
      if (!out.has(r.l)) out.set(r.l, String(r.userId));
    }
  }
  return out;
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
  // 1.99acf: the action, its audit row and the chat hub's privacy/changed row (phase "requested" - the hub applies an ON at once,
  // fail-closed, and an OFF only once Pepe confirms) go in ONE transaction, at request time, before Pepe answers (the chat design
  // §9.2). A busy refusal writes none of them.
  let id;
  try {
    id = await tx(async () => {
      const aid = await require("./actions").queue(String(userId), { kind: "privacy.incognito", args: [on ? "on" : "off"], tag: "privacy",
                                                                     label: `incognito ${on ? "on" : "off"}` });
      const at = now();
      await log({ userId, login, kind: "request", on, via: "web", ip, at });
      await require("./huboutbox").emit("privacy/changed", entityOf(login),
        { flag: "incognito", value: on, phase: "requested", via: "web", subject: subjectOf(login, String(userId)), at },
        { dedupe: "incog-req:" + aid });
      return aid;
    });
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.", "busy");
    throw e;
  }
  // CL2: an ON request hides the key's archived pad-chat lines at once, before Pepe confirms (the sticky hidden set, src web;
  // chatlog.js). An OFF request changes nothing there: only Pepe's un-hide (privacy.shown) does. CL2 fix-up: a linked account's
  // own web lines from before it linked (archived under u:<userId>) are its chat lines too - hidden with the login, and shown
  // again with it (reason of:<login>)
  // 1.99add (spec §3.1): an ON is applied to the sticky hidden set at once (src web), before Pepe confirms - quotes, tips,
  // mentions, boost and go-live lines stop naming them now. If Pepe never applies it (the action fails or expires) it is
  // undone (actionsSettled - run here too, in case Pepe already answered it in the moment since the transaction). An OFF waits
  // for Pepe's report (hubhidden.offReported). (The chat archive's set keeps its own rule: only Pepe's privacy.shown un-hides.)
  if (on) {
    try {
      const CL = require("./chatlog");
      await CL.hideNow([login], "web");
      if (!ACCT_RE.test(login)) await CL.hideNow(["u:" + String(userId)], "web", "incognito", { of: login });
    } catch (e) { console.error("[incognito] archive hide:", e.message); }
    await require("./hubhidden").hideNow(login, "web");
    await actionsSettled([id]);
  }
  return { id };
}

// 1.99add: what became of a website Incognito ON. hubhidden.hideNow hid them at once; the action's outcome tells whether Pepe
// applied it: done -> he did (a "web" hash is now as sure as his own report); failed - he refused it, or it expired before he
// claimed it (actionttl.js, 15 min) -> he never did, and a hash only that request put there is un-hidden again (their state in
// Pepe and on Settings is OFF - they would otherwise stay "someone" for good). Decided once no other ON of theirs is still open
// (that one decides). Called by actions.js (Pepe's ack) and actionttl.js (the expiry sweep); never rejects.
const ON_ARGS = JSON.stringify(["on"]);
function actionKey(a) {
  const c = low(a && a.camfrog);
  if (c) return LOGIN_RE.test(c) ? c : null;                // the login it was queued for (request() acted for it)
  const k = "u:" + String(a && a.user_id);
  return ACCT_RE.test(k) ? k : null;                        // 1.99xa: an account with no chat login
}
async function settleAction(a) {
  if (!a || a.args !== ON_ARGS || (a.status !== "done" && a.status !== "failed")) return false;
  const open = (await getQuery(`SELECT 1 AS x FROM pepe_actions WHERE user_id = ? AND kind = 'privacy.incognito' AND args = ? AND id <> ?
                                AND status IN ('pending', 'claimed') LIMIT 1`, [String(a.user_id), ON_ARGS, a.id]))[0];
  if (open) return false;
  const key = actionKey(a);
  if (!key) return false;
  await require("./hubhidden").webSettled(key, a.status === "done");
  return true;
}
/** Pepe answered these actions (ack) or they expired: the incognito ONs among them settle the sticky hidden set. -> how many */
async function actionsSettled(ids) {
  try {
    const want = [...new Set((Array.isArray(ids) ? ids : [ids]).map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 200);
    if (!want.length) return 0;
    const rows = await getQuery(`SELECT id, user_id, camfrog, args, status FROM pepe_actions WHERE kind = 'privacy.incognito'
                                 AND id IN (${want.map(() => "?").join(",")})`, want);
    let n = 0;
    for (const a of rows) if (await settleAction(a)) n++;
    return n;
  } catch (e) {
    console.error("[incognito] action outcome:", e.message);
    return 0;
  }
}
/** At start-up (once the hidden set is back): each member's newest website ON of the last 30 days that has an outcome settles
 *  again - an outcome that came while the site was down, or just before a restart, still counts. -> how many keys */
async function reconcileWeb() {
  try {
    const rows = await getQuery(`SELECT id, user_id, camfrog, args, status FROM pepe_actions WHERE kind = 'privacy.incognito' AND args = ?
                                 AND created > ? ORDER BY id DESC LIMIT 5000`, [ON_ARGS, Date.now() - 30 * 86400000]);
    const seen = new Set(), ok = [], bad = [];
    for (const a of rows) {
      if (seen.has(a.user_id)) continue;
      seen.add(a.user_id);
      if (a.status !== "done" && a.status !== "failed") continue;     // still open: its outcome will come
      const k = actionKey(a);
      if (k) (a.status === "done" ? ok : bad).push(k);
    }
    const H = require("./hubhidden");
    if (ok.length) await H.webSettled(ok, true);
    if (bad.length) await H.webSettled(bad, false);
    return ok.length + bad.length;
  } catch (e) {
    console.error("[incognito] reconcile:", e.message);
    return 0;
  }
}

// 1.99acf: the chat hub's id for a chat key and its subject - never any line text. The subject's acct is the hub's account_id
// (the ticket's sub: huboutbox.accountOf -> chatticket.subjectOf, a legacy id -> its UUIDv5), the raw users.userId beside it
// as v1_user; the entity stays v1's own ordering key. 1.99acm (seam plan D-6): a chat login never leaves v1 - its entity is
// "cfh:<h>" and its subject carries login_h, h = hubhidden.loginHash(login) (sha256("pepe-hidden:" + lower(trim(login)))[:20],
// quotes.hiddenHash's form); an account key is "acct:<userId>". null for a key the hub wouldn't accept (never sent).
function entityOf(login) {
  const m = ACCT_RE.exec(String(login));
  if (m) return "acct:" + m[1];
  const h = require("./hubhidden").loginHash(low(login));
  return h ? "cfh:" + h : null;
}
function subjectOf(login, acct) {
  const m = ACCT_RE.exec(String(login));
  const of = (id) => ({ acct: require("./huboutbox").accountOf(id), v1_user: String(id) });
  if (m) return of(m[1]);
  const lh = require("./hubhidden").loginHash(low(login));
  return acct ? { platform: "camfrog", login_h: lh, ...of(acct) } : { platform: "camfrog", login_h: lh };
}
/** Inside a transaction: the hub's privacy/changed row for a key Pepe reported (phase "confirmed"). */
function emitConfirmed(login, on, via, user, at, dedupe) {
  const entity = entityOf(login);
  if (!entity) return false;
  return require("./huboutbox").emit("privacy/changed", entity,
    { flag: "incognito", value: on, phase: "confirmed", via, subject: subjectOf(login, user && !ACCT_RE.test(login) ? user : null), at }, { dedupe });
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
    const u = await userByLogin(login);
    const on = it.on === true;
    const via = it.via === "web" ? "web" : "chat";
    const cur = u ? (await getQuery(`SELECT "on" AS "on", updated FROM incognito_state WHERE login = ?`, [login]))[0] : null;
    const stale = !!(cur && Number(cur.updated) > ts);   // an older report than what we have
    // 1.99acf: each report in one transaction with its chat-hub row (privacy/changed, phase "confirmed"; unlinked logins too)
    await tx(async () => {
      if (on) await runQuery("INSERT INTO incognito_anon (login, since) VALUES (?, ?) ON CONFLICT(login) DO NOTHING", [login, t]);
      else await runQuery("DELETE FROM incognito_anon WHERE login = ?", [login]);
      if (stale) return;
      if (u) {
        await runQuery(`INSERT INTO incognito_state (login, "on", updated, reported, via) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(login) DO UPDATE SET "on" = excluded."on", updated = excluded.updated, reported = excluded.reported, via = excluded.via`,
                       [login, on ? 1 : 0, ts, t, via]);
        await log({ userId: u.userId, login, kind: "applied", on, via, at: t });
      }
      await emitConfirmed(login, on, via, u ? u.userId : null, ts, `incog:${login}:${ts}`);
    });
    // CL2: the chat archive's sticky hidden set - ON hides any key Pepe reports (its incognito reason, at Pepe's time; a linked
    // login's account key u:<userId> too - its web lines from before it linked). CL2 fix-up: OFF un-hides NOTHING here - only
    // Pepe's explicit privacy.shown {scope: incognito} does (a report, or a list that no longer has them, can't tell whether
    // !bridge hide still hides the person)
    if (!stale && on) {
      try {
        const CL = require("./chatlog");
        await CL.hideNow([login], "pepe", "incognito", { at: ts });
        if (u && !ACCT_RE.test(login)) await CL.hideNow(["u:" + String(u.userId)], "pepe", "incognito", { of: login, at: ts });
      } catch (e) { console.error("[incognito] archive hidden set:", e.message); }
    }
    // 1.99add: the sticky hidden set (hubhidden.js: quotes + the hub's hh: cache). 1.99add refix 4: it keeps WHY someone is hidden,
    // and these reports touch only the INCOGNITO kind - !bridge hide (and an older Pepe's mixed list) is never undone here. Every
    // report goes there, linked or not, also one this table calls stale: an ON always hides (a report that looks older than his
    // last OFF means his clock went back - never leave anyone named for that); an OFF takes the incognito kind away unless it
    // is older than an ON that arrived just now (hubhidden judges a late post). The `full` list below only adds there.
    if (on) await require("./hubhidden").hiddenReported(login, ts);
    else await require("./hubhidden").offReported(login, ts, { changed: it.changed !== false });
    if (!u || stale) { ignored++; continue; }              // only linked chat identities are kept
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
    // 1.99acm: the heal runs in ONE transaction with the chat hub's rows: every key whose effective state it changes (a login
    // that is ON only because the full list says so - Pepe restarted, an item report was lost - or one the list turns OFF)
    // writes a privacy/changed "confirmed" row at once, so the hub never waits for the next snapshot to hide it (§1.3, §9.2)
    const set = new Set(body.full.map(low).filter(isKey));
    await tx(async () => {
      const changed = new Map();                         // key -> on
      const wasOn = new Set((await getQuery("SELECT login FROM incognito_anon")).map((r) => r.login));
      for (const r of await getQuery(`SELECT login FROM incognito_state WHERE "on" = 1`)) wasOn.add(r.login);
      for (const l of wasOn) if (!set.has(l)) changed.set(l, false);
      for (const l of set) if (!wasOn.has(l)) changed.set(l, true);
      for (const l of wasOn) if (!set.has(l)) await runQuery("DELETE FROM incognito_anon WHERE login = ?", [l]);
      for (const l of set) await runQuery("INSERT INTO incognito_anon (login, since) VALUES (?, ?) ON CONFLICT(login) DO NOTHING", [l, t]);
      // stored logins that are no longer on the list -> off
      for (const r of await getQuery(`SELECT login FROM incognito_state WHERE "on" = 1`)) {
        if (!set.has(r.login)) await runQuery(`UPDATE incognito_state SET "on" = 0, reported = ? WHERE login = ?`, [t, r.login]);
      }
      const users = await usersByLogins([...set, ...changed.keys()].filter((l) => !ACCT_RE.test(l)));
      const userOf = (l) => { const m = ACCT_RE.exec(l); return m ? m[1] : users.get(l) || null; };
      for (const l of set) {
        if (ACCT_RE.test(l) ? !(await userByLogin(l)) : !users.has(l)) continue;
        await runQuery(`INSERT INTO incognito_state (login, "on", updated, reported, via) VALUES (?, 1, NULL, ?, 'full')
                        ON CONFLICT(login) DO UPDATE SET "on" = 1, reported = excluded.reported`, [l, t]);
      }
      for (const [l, on] of changed) await emitConfirmed(l, on, "chat", userOf(l), t, `incog-full:${l}:${t}`);
      await runQuery("INSERT INTO incognito_meta (key, value) VALUES ('last_full', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(t)]);
    });
    // CL2: everyone on the full list is hidden in the chat archive too; a key missing from it is NEVER un-hidden (add-only). CL2
    // fix-up: as their incognito reason, a list's say-so (added if missing, never moves its time - assert)
    try { if (set.size) await require("./chatlog").hideNow([...set], "pepe", "incognito", { assert: true }); } catch (e) { console.error("[incognito] archive hidden set:", e.message); }
    // 1.99add refix 4: Pepe's word on who is incognito now - the sticky hidden set's incognito kind gains them (adds only; absence
    // un-hides nobody there). After a deploy it learns this way who has been incognito since long before (their older Pepe's
    // list hides them as "unknown": if that list ever loses them, they still show as "someone", never by name)
    await require("./hubhidden").fullReported([...set]);
  }
  return { applied, ignored };
}

function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[incognito] init:", e.message));
  // 1.99add: website ONs Pepe answered (or that expired) while the site was down settle the sticky hidden set once it is back
  require("./hubhidden").whenBooted(reconcileWeb);
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
      // 1.99yt: + the 📺 "my cam on Pepe's main stream" opt-in (onair.js owns it)
      let oa = null;
      try { oa = await require("./onair").optinState(req.user.userId); } catch (e) { oa = null; }
      // 1.99aaf: 👻 ghost mode - its card shows to site staff only (ghost.js)
      let gh = null;
      try { const g = await require("./ghost").state(req.user.userId); gh = g.staff ? g : null; } catch (e) { gh = null; }
      // 1.99aat: 🧠 "Make Pepe forget me" (pepeforget.js) - when it was last asked
      let pf = null;
      try { pf = await require("./pepeforget").last(req.user.userId); } catch (e) { pf = null; }
      // stagefix site: the 🎬 card names Camfrog's "!stage off me" only once Pepe forwards it (livecam.stageOffMeOk - a bot change)
      let slChat = false, slOk = false;
      try { slChat = require("./livecam").stageOffMeOk(); slOk = require("./livecam").stageOkOk(); } catch (e) { slChat = false; slOk = false; }
      // stagefix final round: ...and "!stage ok / no" (the answers to stagepin.js's asks) once he forwards those (stageOkOk)
      // micfollow: 🎙 "Pads may put my cam on their stage while I hold the mic" + the person's own mic stages (micfollow.js)
      let mf = null;
      try { mf = await require("./micfollow").privacyState(req.user.userId); } catch (e) { mf = null; }
      res.render("privacy-settings", { user: req.user.username, st: await stateOf(req.user.userId), lc, oa, gh, pf, slChat, slOk, mf });
    } catch (e) { next(e); }
  });
}

// 1.99acm: entityOf / subjectOf / userByLogin / loginOf are shared with huboutbox.js's privacy/changed snapshot (the same
// entity and subject the feed rows carry).
module.exports = { init, register, request, sync, stateOf, entityOf, subjectOf, userByLogin, usersByLogins, loginOf, isKey, ACCT_RE, RATE_MAX, RATE_WINDOW_MS,
                   actionsSettled, reconcileWeb, Refuse, _setClock: (f) => { clock = f; } };
