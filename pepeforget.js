// pepeforget.js — 1.99aat: 🧠 "Make Pepe forget me" - a member asks Pepe to forget what he remembers about them and to
// delete their PRIVATE conversations with him. Two halves, one request:
//   * the site's half (here, at once): every message in the member's 1:1 conversation with Pepe's account ("Message
//     Pepe" on /messages - his short-term memory there, and the Telegram chat's answers live in Pepe, not here) is
//     deleted for both sides the way a deleted message is (body gone, "message deleted", its pictures stop being served
//     and the media sweep erases them; a report's own text snapshot stays with the report), and Pepe's open jobs for
//     that conversation are dropped;
//   * Pepe's half (camfrog-bot pepe_incognito._incog_forget_all): his memory profile of them (facts, aliases, links),
//     the PM lines not yet turned into memories, their mic-session log, their Camfrog PM logs (pmlogs/<login>/) and the
//     PM / Telegram chat history he holds in memory. From the website it's the website action "privacy.forgetme" (the
//     linked chat login, or the account key "u:<id>" for an account without one); from Camfrog `!forgetme now` +
//     `!forgetme confirm`, and Pepe calls POST /api/privacy/pepe-forget/bot so the website half happens too.
// What it is NOT: public room chat, mic transcripts and captures are the room's record (and other people's); this
// doesn't switch on incognito either - Pepe starts learning again if they keep talking to him (the page says so).
// CL6: unless they tick "Also hide my past public chat lines" (decision 14, unticked by default): then their linked login and
// their account key join the pad chat archive's sticky hidden set for good (hideLines; src forget - Pepe can't un-hide them).
// CL13 fix-up: nor the copies of Camfrog PMs Pepe's admins sent them with `!msg` (dm_relays, the account-pair DM or the
// admin's own "📨 Sent in Camfrog to <login>" log) - those are the admin's messages; they stay until the recipient clears
// the conversation / the admin deletes them, and the login in them is replaced only by account deletion or, for someone
// without an account, privacy@ (tools/cflogin.js). The settings page (pf.what_msg) and the privacy policy say so.
// Every request is logged (pepe_forget_log: who, when, how, counts) - nothing about what was said.
// 1.99acm: the chat hub's half (huboutbox topic privacy/forget, switch hubseam.erasure - the R-12 privacy seam, seam plan D-24):
// for a PATV account (the web request, or Pepe's for a linked login / account key) the DM wipe, the log row and a
// privacy/forget row {subject_kind:"acct", acct, v1_user, scope:"bot", ref} commit in ONE transaction - the hub forgets the
// account's conversations with its bots. A login with no linked account sends nothing (identity-scoped requests are S2's).
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const guard = require("./middleware/authGuard");

const PEPE_ID = "pepe-bot";
const RATE_MAX = 3;                        // requests per member per day
const RATE_WINDOW_MS = 24 * 3600 * 1000;
const LOGIN_RE = /^[\w.\-$]{1,40}$/;

let clock = () => Date.now();
const now = () => clock();
class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pepe_forget_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, login TEXT, at INTEGER NOT NULL,
                      via TEXT NOT NULL, dms INTEGER NOT NULL DEFAULT 0, action_id TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS pepe_forget_log_user ON pepe_forget_log (user_id, at)");
      // CL6: "Also hide my past public chat lines" was ticked (decision 14) - the record of it, no content
      const cols = (await getQuery("SELECT name FROM pragma_table_info('pepe_forget_log')")).map((r) => r.name);
      if (!cols.includes("hide_lines")) await runQuery("ALTER TABLE pepe_forget_log ADD COLUMN hide_lines INTEGER");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Delete every message of `userId`'s 1:1 conversation(s) with Pepe. -> how many messages were deleted. */
async function wipeDms(userId, t = now()) {
  await require("./messages").init();
  const convs = await getQuery(`SELECT c.id FROM conversations c
                                JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
                                JOIN conversation_members p ON p.conversation_id = c.id AND p.user_id = ?
                                WHERE c.kind = 'dm'`, [String(userId), PEPE_ID]);
  let n = 0;
  for (const c of convs) {
    const r = await runQuery("UPDATE messages SET body = NULL, deleted_at = ?, deleted_by = 'forget' WHERE conversation_id = ? AND deleted_at IS NULL AND kind != 'system'",
      [t, c.id]);
    n += (r && r.changes) || 0;
    try { await runQuery("DELETE FROM pepe_dm_jobs WHERE conversation_id = ?", [c.id]); } catch (e) { /* no jobs table yet */ }
  }
  return n;
}

const loginOf = async (userId) => {
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  const l = r && r.camfrogUsername ? String(r.camfrogUsername).toLowerCase() : "";
  return LOGIN_RE.test(l) ? l : null;
};

/** CL6 (decision 14): "Also hide my past public chat lines" - the account's linked login and its u:<id> key join the pad chat
 *  archive's sticky hidden set for good (src forget: Pepe can never un-hide them): their lines are left out of every pad's chat,
 *  history, search and downloads, and their names are redacted in other people's lines. Outside any transaction (the hidden set
 *  serialises its own writes). -> keys hidden */
async function hideLines(userId, login) {
  const keys = ["u:" + String(userId).toLowerCase(), login || null].filter(Boolean);
  await require("./chatlog").hideNow(keys, "forget");
  return keys.length;
}

/** The member asks from the website. opts.hideLines: also hide their past public chat lines (CL6). -> {ok, dms, action, lines_hidden?} */
async function request(userId, { t = now(), hideLines: hide = false } = {}) {
  await init();
  const uid = String(userId);
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM pepe_forget_log WHERE user_id = ? AND at > ?", [uid, t - RATE_WINDOW_MS]))[0].n;
  if (recent >= RATE_MAX) throw new Refuse(429, "You've asked a few times today already - try again tomorrow.", "rate");
  const login = await loginOf(uid);
  // CL6: first, and never inside the transaction below - hiding is what they asked for even if the rest has to be retried
  if (hide) await hideLines(uid, login);
  await require("./messages").init();                 // (table creation never inside the transaction below)
  let dms = 0, action = null, ref = null;
  try {
    // 1.99acm: one transaction - the DM wipe, Pepe's action, the log row and the chat hub's privacy/forget row. The action is
    // exempt from Pepe's "busy" cap (actions.queue): the request never depends on his queue having room
    ({ dms, action, ref } = await tx(async () => {
      const n = await wipeDms(uid, t);
      const a = await require("./actions").queue(uid, { kind: "privacy.forgetme", args: [], tag: "privacy", label: "forget me" });
      const r = await runQuery("INSERT INTO pepe_forget_log (user_id, login, at, via, dms, action_id, hide_lines) VALUES (?, ?, ?, 'web', ?, ?, ?)",
                               [uid, login, t, n, a ? String(a) : null, hide ? 1 : null]);
      const id = r && (r.id || r.lastID);
      await emitForget(id, uid, t);
      return { dms: n, action: a, ref: id };
    }));
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment, then try again.", "busy");
    throw e;
  }
  console.log(`[pepeforget] ${uid}${login ? " (" + login + ")" : ""}: ${dms} DM(s) with Pepe deleted, Pepe asked to forget (web)${hide ? ", past chat lines hidden" : ""}`);
  return { ok: true, dms, action, ref, ...(hide ? { lines_hidden: true } : {}) };
}

/** 1.99acm: a pepe_forget_log row of an account -> the chat hub's privacy/forget payload (the feed row and the snapshot's). */
function hubRow(r) {
  return { subject_kind: "acct", acct: require("./huboutbox").accountOf(r.user_id), v1_user: String(r.user_id), scope: "bot", ref: Number(r.id),
           at: Number(r.at) || null };
}
/** Inside the request's transaction: the privacy/forget row (a no-op while hubseam.erasure is off). */
function emitForget(id, userId, t) {
  if (!id || userId == null) return false;
  return require("./huboutbox").emit("privacy/forget", "forget:" + id, hubRow({ id, user_id: userId, at: t }), { dedupe: "forget:" + id });
}

/** Pepe (bot token) after `!forgetme confirm` in Camfrog: the website half for the accounts linked to that login. */
async function fromBot(login, { t = now() } = {}) {
  await init();
  const l = String(login || "").trim().toLowerCase();
  if (!LOGIN_RE.test(l) && !/^u:[\w-]{1,64}$/.test(l)) return { ok: false, error: "bad login" };
  const ids = l.startsWith("u:") ? [l.slice(2)]
    : (await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [l])).map((r) => String(r.userId));
  let dms = 0;
  await require("./messages").init();
  for (const id of ids) {
    // 1.99acm: per account, the wipe, the log row and the chat hub's privacy/forget row in one transaction
    dms += await tx(async () => {
      const n = await wipeDms(id, t);
      const r = await runQuery("INSERT INTO pepe_forget_log (user_id, login, at, via, dms) VALUES (?, ?, ?, 'chat', ?)", [id, l, t, n]);
      await emitForget(r && (r.id || r.lastID), id, t);
      return n;
    });
  }
  if (!ids.length) await runQuery("INSERT INTO pepe_forget_log (user_id, login, at, via, dms) VALUES (NULL, ?, ?, 'chat', 0)", [l, t]);
  console.log(`[pepeforget] ${l}: ${dms} DM(s) with Pepe deleted (chat, ${ids.length} linked account(s))`);
  return { ok: true, dms, accounts: ids.length };
}

async function last(userId) {
  await init();
  const r = (await getQuery("SELECT at, via FROM pepe_forget_log WHERE user_id = ? ORDER BY id DESC LIMIT 1", [String(userId)]))[0];
  return r ? { at: Number(r.at), via: r.via } : null;
}

function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[pepeforget] init:", e.message));
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
    console.error("[pepeforget]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.post("/api/privacy/pepe-forget", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (String((req.body || {}).confirm || "").trim().toLowerCase() !== "forget") return res.status(400).json({ ok: false, error: "Type FORGET to confirm." });
    try { res.json(await request(req.user.userId, { hideLines: (req.body || {}).hide_lines === true })); } catch (e) { fail(res, e); }
  });
  app.post("/api/privacy/pepe-forget/bot", async (req, res) => {
    const b = req.body || {};
    if (typeof isBotToken !== "function" || !isBotToken(b.password)) return res.status(403).json({ ok: false });
    try { res.json(await fromBot(b.login)); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, request, fromBot, wipeDms, hideLines, last, hubRow, Refuse, RATE_MAX, PEPE_ID,
  _setClock: (fn) => { clock = fn || (() => Date.now()); } };
