// memoryoptout.js — 🧠 "Pepe's memory" (wave 3, incognito/mic-stage design §N, owner-approved 2026-10-28): the website half
// of Pepe's memory opt-out ("Pepe, don't remember me"). Settings → Privacy (/settings/privacy#memory).
//
// Pepe owns the switch (camfrog-bot pepe_incognito._mem_set: memory_store.data["memory_optout"], read through
// memory_store.remembers(login)); this module only ASKS and SHOWS, the incognito.js way. It is separate from incognito and
// !bridge hide (the owner's rule of 2026-10-27: those are about the bridge - what the website shows - only).
//
// POLARITY: `on` on the wire (the action's argument, Pepe's report items, the API below) = the OPT-OUT is on: the login is on
// Pepe's memory_optout list and he does NOT remember what they tell him. The Settings card's switch "Let Pepe remember what I
// tell him" is the opposite (checked = on: false). `!remember off` in chat = on: true.
//
//   POST /api/privacy/memory {on}          the signed-in member's request (same-site fetch). Needs a chat identity (the linked
//                                          Camfrog login, or the account key "u:<userId>" while a Pepe that honours it runs -
//                                          incognito.js's rule) and a Pepe that has the switch (capable()). Queued as Pepe's
//                                          website action "privacy.memory" [on|off] (actions.js; exempt from the "busy" cap like
//                                          privacy.forgetme) - Pepe runs the same _mem_set as !remember. Audit row "request";
//                                          at most RATE_MAX requests per RATE_WINDOW_MS per account (429).
//   GET  /api/privacy/memory               the member's state AS PEPE LAST REPORTED IT + `waiting` while a request has no report
//                                          newer than it yet (the card shows "Waiting for Pepe…") + the recent audit rows
//   Pepe's report rides the incognito report loop (pepe_incognito's queue: every 20 s while something is pending, the full lists
//   every 10 minutes): POST /api/privacy/incognito/sync {items: [..., {login, kind: "memory", on, via, changed, ts}],
//   full_memory?: [logins opted out], caps?: ["memory"]} - incognito.sync hands it here (sync(body)). Only LINKED chat identities
//   are stored; each reported change files an audit row "applied" and, when it really changed, ONE inbox notice (ref
//   mem:<login>:<ts>). `full_memory` heals the table (listed linked keys on, every other stored one off) and is counted for the
//   admins (/admin/pepe: how many, never who).
//
// THE CAPABILITY MARKER: a Pepe that has the switch puts caps: ["memory"] in EVERY report body. The site keeps the LATEST
// report's caps (memory_optout_meta). capable() = that latest report had "memory". Until then - and after a rollback to a Pepe
// without it - the Settings card, forget-me's "Keep it that way" box, the privacy policy's "Pepe's memory" text (terms.js:
// privacyCopy()), the settings hub row and the incognito copy's v2 wording stay hidden and a request is refused
// ("unsupported"), so the text is never false whatever the deploy order. The sync's answer carries caps: ["memory"] too, so
// Pepe can tell that this site understands kind "memory" items (an older site would take them as incognito reports).
//
//   memory_optout_state  login (lower, PK), on, updated (Pepe's ms of the change), reported (when the site heard it), via
//   memory_optout_log    id, user_id, login, at, kind request|applied|refused, on, via, ip
//   memory_optout_meta   key/value: caps (JSON, the latest report's), caps_at, cap_first_at (the first report with "memory" -
//                        the privacy policy's date for the text), last_full, full_n
//
// Account deletion removes the account's rows (accountdelete.js: DELETE_ROWS for the login and the audit, and the account key's
// row); Pepe's side goes with his privacy.forget action. Forget-me (pepeforget.js) queues a privacy.memory "on" in its own transaction when the member keeps
// "Keep it that way - don't remember me from now on" ticked (the default, §N.4).
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const KIND = "privacy.memory";
const CAP = "memory";
const RATE_MAX = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
// a request with no report yet is "waiting" for as long as its action can still run (actionttl.js: privacy.memory 1440 min - it
// rides along with forget-me's, which waits that long; N.6: Pepe offline -> the request waits and the card says so)
const WAIT_MS = 24 * 60 * 60 * 1000;
const FAILED_MS = 15 * 60 * 1000;        // a failed / expired request is shown this long
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const ACCT_RE = /^u:([A-Za-z0-9-]{6,64})$/;
const isKey = (l) => LOGIN_RE.test(l) || ACCT_RE.test(l);
// how Pepe says the switch was changed: web (Settings), chat (!remember in a room or PM), telegram (/remember), forget (forget-me's
// "keep it that way"), full (the full list) - anything else is "chat". 1.99aft (review): + Pepe's two carry-overs, which only ever
// switch it OFF: ident (a switch set from a room line under the name the person showed, tied to their login once Pepe could prove
// it - pepe_ident) and rekey (a Camfrog login change, or an account key "u:<id>" becoming a linked login - pepe_loginrekey: the
// same person's earlier choice; no new inbox notice for it)
const VIAS = new Set(["web", "chat", "telegram", "forget", "full", "ident", "rekey"]);
const NO_NOTICE_VIAS = new Set(["rekey"]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayText = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().replace(/^@/, "").toLowerCase();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS memory_optout_state (login TEXT PRIMARY KEY, "on" INTEGER NOT NULL DEFAULT 0, updated INTEGER,
        reported INTEGER, via TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS memory_optout_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, login TEXT, at INTEGER NOT NULL,
        kind TEXT NOT NULL, "on" INTEGER, via TEXT, ip TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS memory_optout_log_user ON memory_optout_log (user_id, at)");
      await runQuery("CREATE TABLE IF NOT EXISTS memory_optout_meta (key TEXT PRIMARY KEY, value TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function meta(key) {
  const r = (await getQuery("SELECT value FROM memory_optout_meta WHERE key = ?", [key]))[0];
  return r ? r.value : null;
}
const setMeta = (key, value) => runQuery("INSERT INTO memory_optout_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                         [key, String(value)]);

async function log(e) {
  try {
    await runQuery(`INSERT INTO memory_optout_log (user_id, login, at, kind, "on", via, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [e.userId ? String(e.userId) : null, e.login ? String(e.login).slice(0, 70) : null, e.at || now(), e.kind,
       e.on == null ? null : e.on ? 1 : 0, e.via ? String(e.via).slice(0, 12) : null, e.ip ? String(e.ip).slice(0, 64) : null]);
  } catch (err) { console.error("[memoryoptout] log:", err.message); }
}

// ── the capability (the latest report's caps) ──
/** {on, at, first_at, first_day}: does the Pepe that sent the LATEST report have the switch? Never throws (false on an error). */
async function capability() {
  try {
    await init();
    let caps = [];
    try { caps = JSON.parse((await meta("caps")) || "[]"); } catch (e) { caps = []; }
    const first = Number(await meta("cap_first_at")) || null;
    return { on: Array.isArray(caps) && caps.includes(CAP), at: Number(await meta("caps_at")) || null, first_at: first,
             first_day: first ? dayText(first) : null };
  } catch (e) { return { on: false, at: null, first_at: null, first_day: null }; }
}
async function capable() { return (await capability()).on; }
/** A report's caps -> stored as the latest (every report, also one without caps: an older Pepe has none). */
async function noteCaps(body, t = now()) {
  await init();
  const caps = (Array.isArray(body && body.caps) ? body.caps : []).filter((s) => typeof s === "string" && /^[a-z0-9_.-]{1,32}$/.test(s)).slice(0, 20);
  await setMeta("caps", JSON.stringify(caps));
  await setMeta("caps_at", t);
  if (caps.includes(CAP) && !(Number(await meta("cap_first_at")) > 0)) await setMeta("cap_first_at", t);
  return caps.includes(CAP);
}
/** views/privacy.ejs (terms.js): null while the latest report has no memory capability; else {on_at, on_day} - when a Pepe first
 *  reported it (the text's date: the changelog entry and "Last updated"). Never throws. */
async function privacyCopy() {
  const c = await capability();
  if (!c.on) return null;
  return { on_at: c.first_at, on_day: c.first_day };
}

// ── who ──
async function hasArchived() {
  try { return (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at"); } catch (e) { return false; }
}
/** The live account a chat identity (a login or "u:<userId>") belongs to, or null. */
async function userOf(key) {
  const m = ACCT_RE.exec(String(key == null ? "" : key).trim());
  if (m) {
    return (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE userId = ? COLLATE NOCASE
                            AND (camfrogUsername IS NULL OR trim(camfrogUsername) = '') ${(await hasArchived()) ? "AND archived_at IS NULL" : ""}`,
                           [m[1]]))[0] || null;
  }
  return require("./incognito").userByLogin(key);
}
/** The account's chat identity: its linked Camfrog login; with none, "u:<userId>" while a Pepe that honours account keys runs
 *  (actorcap.relayOn - incognito.js's rule) or once he has reported on it. -> lower-case key | null */
async function keyOf(userId) {
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  if (!r) return null;
  const l = low(r.camfrogUsername);
  if (l) return LOGIN_RE.test(l) ? l : null;
  const key = low("u:" + String(userId));
  if (!ACCT_RE.test(key)) return null;
  if (require("./actorcap").relayOn()) return key;
  const had = (await getQuery("SELECT 1 AS x FROM memory_optout_state WHERE login = ?", [key]))[0];
  return had ? key : null;
}

/** The member's switch as Pepe reported it. {capable, linked, login, account, on (true = Pepe does NOT remember them; null = not
 *  reported yet), since (when it went on), updated, reported, waiting: {id, want, status} | null, failed: {message} | null, log} */
async function stateOf(userId) {
  await init();
  const cap = await capability();
  const login = await keyOf(userId);
  const out = { capable: cap.on, linked: !!login, login, account: !!(login && ACCT_RE.test(login)), on: null, since: null, updated: null,
                reported: null, waiting: null, failed: null, log: [] };
  if (out.account) {
    const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [String(userId)]))[0];
    out.name = u ? u.username : null;
  }
  out.log = await getQuery(`SELECT at, kind, "on" AS "on", via FROM memory_optout_log WHERE user_id = ? AND kind IN ('request', 'applied', 'refused')
                            ORDER BY id DESC LIMIT 8`, [String(userId)]);
  if (!login) return out;
  const r = (await getQuery(`SELECT "on" AS "on", updated, reported FROM memory_optout_state WHERE login = ?`, [login]))[0];
  const full = Number(await meta("last_full")) || null;
  if (r) {
    out.on = !!r.on; out.updated = Number(r.updated) || null; out.reported = Number(r.reported) || null;
    if (out.on) out.since = out.updated || out.reported;
  } else if (full || cap.on) {
    // nobody starts opted out (owner 2026-10-28, N.10 decision 1: no migration) - a capable Pepe's silence is "remembering"
    out.on = false; out.reported = full || cap.at;
  }
  let a = null;
  try {
    a = (await getQuery(`SELECT id, args, status, message, created, updated FROM pepe_actions WHERE user_id = ? AND kind = ?
                         ORDER BY id DESC LIMIT 1`, [String(userId), KIND]))[0] || null;
  } catch (e) { a = null; }
  if (a) {
    let want = null;
    try { want = JSON.parse(a.args)[0] === "on"; } catch (e) { want = null; }
    const answered = out.updated && out.updated >= Number(a.created);
    if (a.status === "failed" || a.status === "expired") {
      if (Date.now() - Number(a.updated || a.created) < FAILED_MS) out.failed = { message: a.message || "" };
    } else if (!answered && Date.now() - Number(a.created) < WAIT_MS) {   // pepe_actions rows carry real time
      out.waiting = { id: a.id, want, status: a.status };
    }
  }
  return out;
}

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code; } }

/** INSIDE a transaction: Pepe's privacy.memory action for `userId` + its audit row. -> the action id. Throws "busy" (actions.queue). */
async function queueIn(userId, login, on, { ip, via = "web" } = {}) {
  const aid = await require("./actions").queue(String(userId), { kind: KIND, args: [on ? "on" : "off"], tag: "privacy",
                                                                 label: on ? "memory: don't remember me" : "memory: remember me" });
  await log({ userId, login, kind: "request", on, via, ip, at: now() });
  return aid;
}

/** The member asks Pepe to stop (on: true) or start again (on: false) remembering them. -> {id} (the action) | throws Refuse. */
async function request(userId, on, { ip } = {}) {
  await init();
  if (typeof on !== "boolean") throw new Refuse(400, "on must be true or false", "bad");
  if (!(await capable())) throw new Refuse(409, "Pepe can't do this yet - it works once he has been updated.", "unsupported");
  const login = await keyOf(userId);
  if (!login) throw new Refuse(409, "Link your chat account first - Pepe's memory is about your chat identity.", "unlinked");
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM memory_optout_log WHERE user_id = ? AND kind = 'request' AND at > ?",
                                 [String(userId), now() - RATE_WINDOW_MS]))[0].n;
  if (recent >= RATE_MAX) {
    await log({ userId, login, kind: "refused", on, via: "web", ip });
    throw new Refuse(429, "That's a lot of switching - try again in a while.", "rate");
  }
  let id;
  try {
    id = await tx(() => queueIn(userId, login, on, { ip, via: "web" }));
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.", "busy");
    throw e;
  }
  return { id };
}

const WHERE = { web: "from Settings → Privacy", chat: "with !remember in chat", telegram: "with /remember on Telegram",
                forget: "when you asked him to forget you", full: "",
                ident: "carried over from !remember off typed in a room under the name you showed there",
                rekey: "carried over from your earlier chat name" };

/** Pepe's report (the incognito report's body: its kind "memory" items, full_memory and caps). -> {applied, ignored, capable} */
async function sync(body) {
  await init();
  const t = now();
  const capableNow = await noteCaps(body, t);
  const items = (Array.isArray(body && body.items) ? body.items : []).filter((it) => it && it.kind === CAP).slice(0, 500);
  let applied = 0, ignored = 0;
  for (const it of items) {
    const login = low(it.login);
    const ts = Math.floor(Number(it.ts) || 0);
    if (!login || !isKey(login) || !(ts > 0)) { ignored++; continue; }
    const u = await userOf(login);
    if (!u) { ignored++; continue; }                     // only linked chat identities are kept
    const on = it.on === true;
    const via = VIAS.has(it.via) ? it.via : "chat";
    const cur = (await getQuery(`SELECT "on" AS "on", updated FROM memory_optout_state WHERE login = ?`, [login]))[0];
    if (cur && Number(cur.updated) > ts) { ignored++; continue; }      // an older report than what we have
    if (cur && Number(cur.updated) === ts && !!cur.on === on) { applied++; continue; }   // a re-sent report: nothing new
    await tx(async () => {
      await runQuery(`INSERT INTO memory_optout_state (login, "on", updated, reported, via) VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(login) DO UPDATE SET "on" = excluded."on", updated = excluded.updated, reported = excluded.reported, via = excluded.via`,
                     [login, on ? 1 : 0, ts, t, via]);
      await log({ userId: u.userId, login, kind: "applied", on, via, at: t });
    });
    applied++;
    if (it.changed === false) continue;
    if (NO_NOTICE_VIAS.has(via) && on) continue;          // 1.99aft: a re-key carries their choice over - audited, no second notice
    const where = WHERE[via] ? ` (${WHERE[via]})` : "";
    const who = ACCT_RE.test(login) ? "your PATV account (what you say in pad chat rooms from the website)" : `your chat name ${login}`;
    await require("./inbox").addSafe(u.userId, {
      kind: "system",
      title: on ? "🧠 Pepe stopped remembering you" : "🧠 Pepe remembers you again",
      body: on
        ? `Pepe switched his memory OFF for ${who}${where}: from now on he learns nothing new from what you say and doesn't bring it up in his answers. What he already knew stays unless you ask him to forget you. Not you? Turn it back on in Settings → Privacy.`
        : `Pepe switched his memory back ON for ${who}${where}: he remembers what you tell him again. Not you? Turn it off in Settings → Privacy.`,
      link: "/settings/privacy#memory", ref: `mem:${login}:${ts}` });
  }
  if (Array.isArray(body && body.full_memory)) {
    // the heal: listed linked keys on, every other stored one off (one transaction). Counted for the admins (how many, never who).
    const set = new Set(body.full_memory.map(low).filter(isKey));
    await tx(async () => {
      for (const r of await getQuery(`SELECT login FROM memory_optout_state WHERE "on" = 1`)) {
        if (!set.has(r.login)) await runQuery(`UPDATE memory_optout_state SET "on" = 0, reported = ? WHERE login = ?`, [t, r.login]);
      }
      for (const l of set) {
        if (!(await userOf(l))) continue;
        await runQuery(`INSERT INTO memory_optout_state (login, "on", updated, reported, via) VALUES (?, 1, NULL, ?, 'full')
                        ON CONFLICT(login) DO UPDATE SET "on" = 1, reported = excluded.reported`, [l, t]);
      }
      await setMeta("last_full", t);
      await setMeta("full_n", set.size);
    });
  }
  return { applied, ignored, capable: capableNow };
}

/** /admin/pepe (admins only): how many people Pepe doesn't remember - never who (§N.3). */
async function adminSummary() {
  await init();
  const cap = await capability();
  const linked = (await getQuery(`SELECT COUNT(*) AS n FROM memory_optout_state WHERE "on" = 1`))[0].n;
  const full = Number(await meta("full_n"));
  const lastFull = Number(await meta("last_full")) || null;
  return { capable: cap.on, caps_at: cap.at, first_at: cap.first_at, linked, all: lastFull ? full : null, last_full: lastFull };
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[memoryoptout] init:", e.message));
  const guard = require("./middleware/authGuard");
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
    console.error("[memoryoptout]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.get("/api/privacy/memory", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await stateOf(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/privacy/memory", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await request(req.user.userId, (req.body || {}).on, { ip: guard.clientIp(req) })) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, request, queueIn, sync, stateOf, keyOf, userOf, capability, capable, noteCaps, privacyCopy, adminSummary,
                   Refuse, KIND, CAP, RATE_MAX, RATE_WINDOW_MS, _setClock: (f) => { clock = f || (() => Date.now()); } };
