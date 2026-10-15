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
// Every request is logged (pepe_forget_log: who, when, how, counts) - nothing about what was said.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
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

/** The member asks from the website. -> {ok, dms, action} */
async function request(userId, { t = now() } = {}) {
  await init();
  const uid = String(userId);
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM pepe_forget_log WHERE user_id = ? AND at > ?", [uid, t - RATE_WINDOW_MS]))[0].n;
  if (recent >= RATE_MAX) throw new Refuse(429, "You've asked a few times today already - try again tomorrow.", "rate");
  const login = await loginOf(uid);
  const dms = await wipeDms(uid, t);
  let action = null;
  try {
    action = await require("./actions").queue(uid, { kind: "privacy.forgetme", args: [], tag: "privacy", label: "forget me" });
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment, then try again.", "busy");
    throw e;
  }
  await runQuery("INSERT INTO pepe_forget_log (user_id, login, at, via, dms, action_id) VALUES (?, ?, ?, 'web', ?, ?)", [uid, login, t, dms, action ? String(action) : null]);
  console.log(`[pepeforget] ${uid}${login ? " (" + login + ")" : ""}: ${dms} DM(s) with Pepe deleted, Pepe asked to forget (web)`);
  return { ok: true, dms, action };
}

/** Pepe (bot token) after `!forgetme confirm` in Camfrog: the website half for the accounts linked to that login. */
async function fromBot(login, { t = now() } = {}) {
  await init();
  const l = String(login || "").trim().toLowerCase();
  if (!LOGIN_RE.test(l) && !/^u:[\w-]{1,64}$/.test(l)) return { ok: false, error: "bad login" };
  const ids = l.startsWith("u:") ? [l.slice(2)]
    : (await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [l])).map((r) => String(r.userId));
  let dms = 0;
  for (const id of ids) {
    const n = await wipeDms(id, t);
    dms += n;
    await runQuery("INSERT INTO pepe_forget_log (user_id, login, at, via, dms) VALUES (?, ?, ?, 'chat', ?)", [id, l, t, n]);
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
    try { res.json(await request(req.user.userId)); } catch (e) { fail(res, e); }
  });
  app.post("/api/privacy/pepe-forget/bot", async (req, res) => {
    const b = req.body || {};
    if (typeof isBotToken !== "function" || !isBotToken(b.password)) return res.status(403).json({ ok: false });
    try { res.json(await fromBot(b.login)); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, request, fromBot, wipeDms, last, Refuse, RATE_MAX, PEPE_ID,
  _setClock: (fn) => { clock = fn || (() => Date.now()); } };
