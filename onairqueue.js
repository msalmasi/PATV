// onairqueue.js — ⏰ on-air links for later (1.99abj): YouTube / Twitch links lined up for Pepe's main stream (onair.js).
//   * "next up" (at = null): goes on air when nothing else is - after the current pick ends (a direct link ends with its
//     video now, onair.js check), in the order they were queued;
//   * "at a time" (at = ms): goes on air at that minute, replacing whatever is on (it was booked on purpose); one that
//     couldn't start within LATE_MS (on-air switched off, the site down) is marked missed, never played late.
// Same rules as a pasted link (onair.setEmbed): the rights tick at queue time (who + when kept on the row and in the
// on-air log when it starts), the stall clock, the IRL feed wins. Staff only (the routes / Pepe's !onair check that).
// Chat times are America/New_York (the site's clock - banner.js, lotto); the web sends an exact ms.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const TZ = "America/New_York";
const MAX_WAITING = 20;
const LATE_MS = 15 * 60 * 1000;           // a booked time this far behind is missed, not played late
const MAX_AHEAD_MS = 14 * 24 * 3600 * 1000;
const EMB = () => require("./stageembed");

let clock = () => Date.now();
const now = () => clock();

class QueueError extends Error { constructor(msg, code) { super(msg); this.status = 400; this.refuse = true; this.code = code || "bad"; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS onair_queue (id TEXT PRIMARY KEY, at INTEGER, url TEXT NOT NULL, label TEXT, by TEXT,
                      created INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', done_at INTEGER, why TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS onair_queue_status ON onair_queue (status, at)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── times (chat: "9pm", "21:30", "9:30 pm tomorrow", "in 45m", "in 1h30m"; the web: an exact ms) ──
function partsIn(ms, tz) {
  const o = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
function offsetMs(ms, tz) {
  const o = partsIn(ms, tz);
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - Math.floor(ms / 1000) * 1000;
}
/** The ms of wall-clock y-m-d h:mi in tz. */
function wallMs(y, m, d, h, mi, tz = TZ) {
  const g = Date.UTC(y, m - 1, d, h, mi);
  let t = g - offsetMs(g, tz);
  t = g - offsetMs(t, tz);
  return t;
}
/** "9pm" / "21:30" / "9:30 pm tomorrow" / "in 45m" / "in 2h" / "in 1h30m" -> ms (the next such time), else null. */
function parseWhen(text, t = now(), tz = TZ) {
  const s = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return null;
  let m = /^in (?:(\d{1,3}) ?h(?:ours?|rs?)?)? ?(?:(\d{1,4}) ?m(?:in(?:utes?|s)?)?)?$/.exec(s);
  if (m && (m[1] || m[2])) {
    const ms = ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) * 60 * 1000;
    return ms > 0 ? t + ms : null;
  }
  let tomorrow = false, rest = s;
  if (/\btomorrow\b/.test(rest)) { tomorrow = true; rest = rest.replace(/\btomorrow\b/, "").trim(); }
  if (/\btoday\b/.test(rest)) rest = rest.replace(/\btoday\b/, "").trim();
  m = /^(\d{1,2})(?::(\d{2}))? ?(am|pm|a|p)?$/.exec(rest);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] || 0);
  const ap = m[3] ? m[3][0] : null;
  if (mi > 59) return null;
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === "p" ? 12 : 0); }
  else if (h > 23 || !m[2]) return null;              // a bare "9" is ambiguous: 9am, 9pm or 21:00
  const o = partsIn(t, tz);
  let at = wallMs(+o.year, +o.month, +o.day, h, mi, tz);
  if (tomorrow) {
    const d = new Date(Date.UTC(+o.year, +o.month - 1, +o.day + 1));
    at = wallMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, tz);
  } else if (at <= t) {
    const d = new Date(Date.UTC(+o.year, +o.month - 1, +o.day + 1));
    at = wallMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, tz);
  }
  return at;
}
/** "Thu 9:00 PM ET" (chat replies). */
function fmt(ms, tz = TZ) {
  return new Date(ms).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET";
}

// ── the queue ──
const shape = (r) => ({ id: r.id, at: r.at == null ? null : Number(r.at), url: r.url, label: r.label, by: r.by, created: Number(r.created),
                        status: r.status, done_at: r.done_at == null ? null : Number(r.done_at), why: r.why || null });
/** Waiting rows: booked times first (by time), then next-up (oldest first). */
async function list() {
  await init();
  const rows = await getQuery("SELECT * FROM onair_queue WHERE status = 'waiting' ORDER BY at IS NULL, at, created LIMIT 100");
  return rows.map(shape);
}
async function recent(n = 10) {
  await init();
  return (await getQuery("SELECT * FROM onair_queue WHERE status != 'waiting' ORDER BY COALESCE(done_at, created) DESC LIMIT ?", [n])).map(shape);
}
/** Queue a link: {url, at (ms | null), by} -> the row. Throws QueueError. The caller checked the rights tick. */
async function add({ url, at = null, by }, t = now()) {
  await init();
  let e = null;
  try { e = EMB().clean(EMB().parse(url)); } catch (err) { throw new QueueError((err && err.message) || "That isn't a YouTube or Twitch link we can play.", "embed_bad"); }
  if (!e) throw new QueueError("That isn't a YouTube or Twitch link we can play.", "embed_bad");
  if (at != null) {
    at = Math.floor(Number(at));
    if (!Number.isFinite(at)) throw new QueueError("That time isn't valid.", "when");
    if (at < t + 30 * 1000) throw new QueueError("That time has already passed - pick a later one (or play it now).", "when");
    if (at > t + MAX_AHEAD_MS) throw new QueueError("At most two weeks ahead.", "when");
  }
  const n = (await getQuery("SELECT COUNT(*) AS n FROM onair_queue WHERE status = 'waiting'"))[0];
  if (n && Number(n.n) >= MAX_WAITING) throw new QueueError(`The on-air queue is full (${MAX_WAITING}) - cancel one first.`, "full");
  const row = { id: crypto.randomBytes(3).toString("hex"), at, url: String(url).trim().slice(0, 500), label: "🔗 " + EMB().label(e),
                by: String(by || "?").slice(0, 80), created: t, status: "waiting" };
  await runQuery("INSERT INTO onair_queue (id, at, url, label, by, created, status) VALUES (?, ?, ?, ?, ?, ?, 'waiting')",
    [row.id, row.at, row.url, row.label, row.by, row.created]);
  return shape(row);
}
async function mark(id, status, why, t = now()) {
  await init();
  await runQuery("UPDATE onair_queue SET status = ?, done_at = ?, why = ? WHERE id = ? AND status = 'waiting'",
    [status, t, why == null ? null : String(why).slice(0, 200), String(id)]);
}
/** Cancel one (id / id prefix) or "all" -> how many. */
async function cancel(which, by, t = now()) {
  await init();
  const w = String(which || "").trim().toLowerCase();
  if (!w) return 0;
  const rows = await list();
  const hit = w === "all" ? rows : rows.filter((r) => r.id === w || (w.length >= 3 && r.id.startsWith(w)));
  for (const r of hit) await mark(r.id, "cancelled", "by " + String(by || "?").slice(0, 60), t);
  return hit.length;
}
/** What should go on air now: a booked time that's due, else (idle) the oldest next-up; overdue bookings -> missed. */
async function due({ idle, enabled }, t = now()) {
  const rows = await list();
  for (const r of rows) {
    if (r.at != null && r.at <= t - LATE_MS) await mark(r.id, "missed", enabled ? "couldn't start in time" : "on-air was switched off", t);
  }
  if (!enabled) return null;
  const booked = rows.find((r) => r.at != null && r.at <= t && r.at > t - LATE_MS);
  if (booked) return booked;
  return idle ? rows.find((r) => r.at == null) || null : null;
}

module.exports = { init, add, list, recent, cancel, mark, due, parseWhen, fmt, wallMs, QueueError, TZ, LATE_MS, MAX_WAITING,
  _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { ready = null; } };
