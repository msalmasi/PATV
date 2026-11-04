// roompm.js — 1.99ajd roompm: Pepe's private answers in a pad's chat ("room PMs"), shown ONLY to the account that typed the command.
//
// The owner, 2026-11-04: "if i do !spin in the bridge, i don't get the acknowledgement or results if pepe is set to send them via PM.
// So we need some type of equivalent notion of a 'room PM' that only you can see on the bridge, that Pepe can use for this."
//
// A "!" command typed in a pad's relay box is a "cmd" job (bridge-relay.js runCmd). Whatever Pepe would have sent that person by Camfrog
// PM while answering it (-p replies, private usage / refusal lines, a chat spin's "spinning..." and its result, a paged help list) comes
// back in the job's ack - `replies` with the final ack, more as late acks (camfrog-bot pepe_relaycmd._relaycmd_capture_pm). This module
// turns THOSE replies into private rows of that pad's chat for that account:
//
//   who   the job's own account and pad (the site made the job from the signed-in session - Pepe never names the account, and nothing
//         here resolves a login to an account). A late ack after the job left bridge-relay's memory finds it in `origins` (24 h).
//   what  typed commands only: never a Manage-panel / 🐸 Pepe-menu / room-setting job (their acks feed padmod.js / padpepe.js), never a
//         say / clip / snap; never Pepe's PUBLIC answers (those reach the pad as his public lines, like any room line).
//   where only in that account's own /live answers for that pad (`rpm`, when the page asks with ?rpm=<last id> - bridge.js liveView), so
//         every tab and the Dock pop-out of that account show it and nobody else ever gets a byte of it. Never in the pad's feed
//         (R.feed / bridge_feed), the chat archive, history, search, downloads, quotes, clips, mentions, Telegram, OBS or analytics.
//   how long  memory only: KEEP rows per (account, pad), each for TTL - a reload or a second tab shows the recent ones, and a site
//         restart / deploy forgets them all (nothing reaches the database, so nothing reaches the nightly backups). Deleting the
//         account forgets its rows at once (accountdelete.js); turning the switch off forgets every row.
//   limits  TEXT_MAX characters a row, RATE rows a minute per (account, pad), MAX_KEYS / MAX_ROWS in all (oldest go first).
//
// The switch: chatlog_meta 'roompm' {on, at, by} - /admin/bridge "Pepe's private answers in pad chat" (admins, audited roompm.switch).
// A missing row = ON (the owner asked for it). Off: no rows, and /live says rpm: {on: 0} (the page shows the command list's 🔒 lines again).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const KEEP = 20;                         // rows per (account, pad) - the last few commands (help, balance, a spin and its result)
const TTL = 24 * 3600 * 1000;            // the "short private history"
const TEXT_MAX = 800;                    // = Pepe's RPM_LINE_MAX
const RATE = 30, RATE_WINDOW = 60 * 1000;
const MAX_KEYS = 5000, MAX_ROWS = 10000;
const ORIGIN_TTL = 24 * 3600 * 1000, MAX_ORIGINS = 20000;
const SEEN_KEEP = 200;                   // ack content keys remembered per (account, pad): a re-sent ack adds nothing (review: digests only,
                                         // never past TTL - the words live in the rows alone)
const SWEEP_MS = 60 * 1000;

let clock = () => Date.now();
const now = () => clock();
const store = new Map();                 // `${userId}|${roomId}` -> {rows: [{id, ts, at, text, cmd}], hits: [ms], seen: Map(digest -> ms)}
const origins = new Map();               // job id -> {userId, roomId, cmd, at}
const gone = new Map();                  // review: digest(deleted account) -> ms - for ORIGIN_TTL its old jobs' late acks add nothing
let lastId = 0, total = 0;
const stats = { added: 0, dup: 0, rate: 0, evicted: 0, local: 0 };
let STATE = { on: true, at: null, by: null };
let ready = null, loaded = false;
// review (privacy): a key made in this process only - the viewer tag `w` (view) and the re-sent ack digests (add) mean nothing
// outside it, and a restart (which forgets every row anyway) changes them
const SALT = crypto.randomBytes(16);
const digest = (s, n = 22) => crypto.createHmac("sha256", SALT).update(String(s)).digest("base64url").slice(0, n);
const goneKey = (uid) => digest("g|" + String(uid));
/** 1.99?? dockpop (owner P1): the viewer tag the Room Dock's windows compare (public/js/dock-link.js; the chat window's vt, ?pop=1 answers) -
 *  this account's key in its own pages and answers only, never the account id. Keyed by the site's secret, not SALT: rpm.w changes on every
 *  restart (deploys), and a tag that changed would close every open chat window as "you signed out". null signed out. */
function tag(userId) {
  if (userId == null || userId === "") return null;
  const key = process.env.SECRET_KEY ? "dock-tag|" + process.env.SECRET_KEY : SALT;
  return crypto.createHmac("sha256", key).update("w|" + String(userId)).digest("base64url").slice(0, 16);
}

// ── the switch ──
function cleanState(o) {
  const v = o && typeof o === "object" ? o : null;
  const n = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : null);
  return { on: v ? v.on !== false : true, at: v ? n(v.at) : null, by: v && typeof v.by === "string" ? v.by.slice(0, 60) : null };
}
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS chatlog_meta (key TEXT PRIMARY KEY, value TEXT)");
      const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'roompm'"))[0];
      try { STATE = cleanState(r ? JSON.parse(r.value) : null); } catch (e) { STATE = cleanState(null); }
      loaded = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** On? (false until the switch is read: a row written before then could be one an admin had switched off) */
function on() {
  if (!loaded) { init().catch(() => {}); return false; }
  return STATE.on === true;
}
function state() { return { ...STATE, loaded, keys: store.size, rows: total, origins: origins.size, stats: { ...stats } }; }
async function setOn(want, user) {
  await init();
  const next = cleanState({ on: want === true, at: now(), by: user && user.username ? user.username : null });
  if (STATE.on === next.on) return { ...state(), unchanged: true };
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('roompm', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  STATE = next;
  if (!next.on) clearAll();
  try { await require("./adminaudit").record(user || { userId: "system" }, "roompm.switch", null, { on: next.on }); } catch (e) { console.error("[roompm] audit:", e.message); }
  console.log(`[roompm] Pepe's private answers in pad chat switched ${next.on ? "ON" : "OFF"} (${(user && user.username) || "?"})`);
  return state();
}

// ── rows ──
// Pepe's replies are shown with textContent; control / bidi characters go, and the markdown markers Camfrog never renders (send_pm
// strips them from the /msg body; the capture holds the raw line) - "**PAT 5,000**" reads "PAT 5,000", as in Camfrog.
function cleanText(s) {
  let t = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ");
  for (const [re, to] of [[/\*\*\*(.+?)\*\*\*/g, "$1"], [/\*\*(.+?)\*\*/g, "$1"], [/\*(.+?)\*/g, "$1"], [/__(.+?)__/g, "$1"],
    [/`(.+?)`/g, "$1"], [/~~(.+?)~~/g, "$1"]]) t = t.replace(re, to);
  t = t.replace(/\s+/g, " ").trim();
  return Array.from(t).slice(0, TEXT_MAX).join("");
}
const cmdOf = (t) => {
  const c = String(t || "").trim().split(/\s+/)[0].toLowerCase();
  return /^![a-z0-9_-]{1,24}$/.test(c) ? c : "";
};
/** A job whose private answers become rows: a command TYPED in a pad's relay box (not a panel / menu / setting job). */
function typedJob(j) {
  return !!(j && j.kind === "cmd" && !j.gui && !j.setting && !j.pepe && j.userId && j.roomId);
}
const keyOf = (userId, roomId) => `${userId}|${roomId}`;
function nextId() {
  // monotonic across restarts: a page's cursor from before a restart never hides a new row
  lastId = Math.max(lastId + 1, now() * 1000);
  return lastId;
}
function entry(userId, roomId, make) {
  const k = keyOf(userId, roomId);
  let e = store.get(k);
  if (!e && make) {
    e = { rows: [], hits: [], seen: new Map() };
    store.set(k, e);
    while (store.size > MAX_KEYS) drop(store.keys().next().value);
  }
  return e || null;
}
function drop(k) {
  const e = store.get(k);
  if (!e) return;
  total -= e.rows.length;
  store.delete(k);
  stats.evicted++;
}
function add(userId, roomId, text, ts, cmd, dupKey) {
  if (gone.size && gone.has(goneKey(userId))) return 0;      // review: a deleted account (forgetUser)
  const t = cleanText(text);
  if (!t) return 0;
  const e = entry(userId, roomId, true);
  if (dupKey) {
    // review (privacy): the key holds the reply's words - only its digest is kept, and only as long as a row is (sweep)
    const dk = digest("d|" + dupKey);
    if (e.seen.has(dk)) { stats.dup++; return 0; }
    e.seen.set(dk, now());
    while (e.seen.size > SEEN_KEEP) e.seen.delete(e.seen.keys().next().value);
  }
  const at = now();
  e.hits = e.hits.filter((h) => at - h < RATE_WINDOW);
  if (e.hits.length >= RATE) { stats.rate++; return 0; }
  e.hits.push(at);
  e.rows.push({ id: nextId(), ts: Number.isFinite(ts) ? Math.min(ts, at + 5000) : at, at, text: t, cmd: cmdOf(cmd) });
  total++;
  while (e.rows.length > KEEP) { e.rows.shift(); total--; }
  // newest last: an active entry moves to the end of the eviction order; then the global cap takes the oldest entries first
  const k = keyOf(userId, roomId);
  store.delete(k); store.set(k, e);
  while (total > MAX_ROWS && store.size > 1) drop(store.keys().next().value);
  stats.added++;
  return 1;
}

/** runCmd made typed-command job `j`: remember whose it is for late acks after bridge-relay forgot the job (JOB_TTL). */
function noteJob(j) {
  if (!typedJob(j) || (gone.size && gone.has(goneKey(j.userId)))) return;
  origins.set(String(j.id), { userId: String(j.userId), roomId: String(j.roomId), cmd: cmdOf(j.text), at: now() });
  while (origins.size > MAX_ORIGINS) origins.delete(origins.keys().next().value);
}

/** One of Pepe's acks (bridge-relay.applyAcks, before it looks the job up). `j` = the job it still holds, or null. Its replies become
 *  rows of the job's account in the job's pad -> {userId, roomId, n} (n rows added) | null (not a typed command's, off, nothing). */
function fromAck(a, j) {
  if (!a || typeof a !== "object" || !on()) return null;
  const jid = String(a.id || "").slice(0, 64);
  if (!jid) return null;
  const o = j ? (typedJob(j) ? { userId: String(j.userId), roomId: String(j.roomId), cmd: cmdOf(j.text) } : null) : origins.get(jid) || null;
  if (!o) return null;
  const replies = (Array.isArray(a.replies) ? a.replies : []).slice(0, 12);
  if (!replies.length) return null;
  // Pepe's clock (the same clock as his room line, the echo of the command): seconds -> the end of that second, so the answer sorts
  // after its own echo
  const pts = Number(a.ts);
  const ts = Number.isFinite(pts) && pts > 0 ? Math.floor(pts) * 1000 + 999 : now();
  let n = 0;
  replies.forEach((r, i) => {
    const t = String(r == null ? "" : r);
    n += add(o.userId, o.roomId, t, ts, o.cmd, a.late ? `${jid}|l|${pts}|${t}` : `${jid}|f|${i}|${t}`);
  });
  return n ? { userId: o.userId, roomId: o.roomId, n } : null;
}

/** A private answer the SITE gave a typed command (the local "!commands") -> rows added (0 / 1). */
function addLocal(userId, roomId, text, cmd) {
  if (!userId || !roomId || !on()) return 0;
  const n = add(String(userId), String(roomId), text, now(), cmd, null);
  if (n) stats.local++;
  return n;
}

/** The account's rows on the pad newer than `afterId` (the page's cursor) -> {v: the newest id there is, rows: [{id, ts, text, cmd}]}
 *  (at most KEEP, oldest first). v = 0 when there are none. */
function since(userId, roomId, afterId = 0) {
  const e = userId && roomId ? entry(String(userId), String(roomId), false) : null;
  if (!e) return { v: 0, rows: [] };
  const t = now(), after = Number(afterId) || 0;
  const live = e.rows.filter((r) => t - r.at < TTL);
  const v = live.length ? live[live.length - 1].id : 0;
  return { v, rows: live.filter((r) => r.id > after).slice(-KEEP).map((r) => ({ id: r.id, ts: r.ts, text: r.text, cmd: r.cmd })) };
}
const latest = (userId, roomId) => since(userId, roomId, Number.MAX_SAFE_INTEGER).v;

/** bridge.js liveView: the `rpm` block of one viewer's /live answer. `pepe` = Pepe's dressed roster entry (the line's look) or null. */
function view(userId, roomId, afterId, pepe = null) {
  if (!on()) return { on: 0 };
  const s = since(userId, roomId, afterId);
  // review (privacy): served through the site's own hidden-name redaction too (chatlogview - the topic's): Pepe redacts opted-out
  // people's names before an answer leaves him, but an older Pepe didn't, and someone may have been hidden since the row came
  let red = (t) => t;
  try {
    const CV = require("./chatlogview");
    if (typeof CV.redact === "function") red = (t) => CV.redact(t);
  } catch (e) { /* no chat views: Pepe's own redaction only */ }
  const rows = s.rows.map((r) => { let t = r.text; try { t = red(t); } catch (e) { /* as kept */ } return Object.assign({}, r, { text: t }); });
  // w (review, privacy): this account's tag - only ever in its own answers; the page drops what it shows when the tag changes (someone
  // else signed in under an open page on a shared computer). Never the account id.
  return { on: 1, w: digest("w|" + userId, 16), v: s.v, u: pepe || null, rows };
}

/** Forget an account's rows everywhere (accountdelete.js). -> rows dropped. review (privacy): and none come back - bridge-relay still
 *  holds the account's jobs for JOB_TTL (and Pepe may answer one of them for hours: a game it started), so the account is marked
 *  gone for ORIGIN_TTL (a digest of its id, never the id) and add() takes nothing for it. */
function forgetUser(uid) {
  const p = String(uid || "") + "|";
  if (p === "|") return 0;
  gone.delete(goneKey(uid)); gone.set(goneKey(uid), now());
  while (gone.size > MAX_ORIGINS) gone.delete(gone.keys().next().value);
  let n = 0;
  for (const [k, e] of [...store]) if (k.startsWith(p)) { n += e.rows.length; total -= e.rows.length; store.delete(k); }
  for (const [id, o] of [...origins]) if (o.userId === String(uid)) origins.delete(id);
  return n;
}
function clearAll() { store.clear(); origins.clear(); total = 0; }

function sweep() {
  const t = now();
  for (const [k, e] of [...store]) {
    const keep = e.rows.filter((r) => t - r.at < TTL);
    total -= e.rows.length - keep.length;
    e.rows = keep;
    e.hits = e.hits.filter((h) => t - h < RATE_WINDOW);
    for (const [dk, at] of [...e.seen]) if (t - at >= TTL) e.seen.delete(dk);
    if (!e.rows.length && !e.hits.length) store.delete(k);
  }
  for (const [id, o] of [...origins]) if (t - o.at > ORIGIN_TTL) origins.delete(id);
  for (const [g, at] of [...gone]) if (t - at > ORIGIN_TTL) gone.delete(g);
}
setInterval(() => { try { sweep(); } catch (e) { /* never breaks the site */ } }, SWEEP_MS).unref();

// ── /admin/bridge: the switch (site admins) ──
function register(app, { addUser }) {
  init().catch((e) => console.error("[roompm] init:", e.message));
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "2kb" });
  const can = (req) => !!(req.user && SP.can(req.user, "chatlog.admin"));
  app.get("/api/admin/roompm", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { await init(); res.json({ ok: true, state: state() }); }
    catch (e) { console.error("[roompm] admin:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/roompm", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    const b = req.body || {};
    if (typeof b.on !== "boolean") return res.status(400).json({ ok: false, error: "Say on: true or false." });
    try { res.json({ ok: true, state: await setOn(b.on, { userId: req.user.userId, username: req.user.username }) }); }
    catch (e) { console.error("[roompm] switch:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
}

module.exports = { init, on, state, setOn, typedJob, noteJob, fromAck, addLocal, since, latest, view, forgetUser, register, cleanText, tag,
                   KEEP, TTL, TEXT_MAX, RATE, MAX_KEYS, MAX_ROWS,
                   _sweep: sweep, _store: store, _origins: origins,
                   _setClock: (f) => { clock = f || (() => Date.now()); },
                   _reset: () => { clearAll(); gone.clear(); lastId = 0; for (const k of Object.keys(stats)) stats[k] = 0; } };
