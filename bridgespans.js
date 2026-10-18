// bridgespans.js — when each Camfrog room was bridged to the web (R-11, 1.99acf; the chat design §3.7 "VM-log pipeline").
//
// A later import of Pepe's VM chat logs (R-10) may only take lines the website actually showed, so it needs evidence of WHEN
// a room was bridged. From now on that evidence is recorded here, from Pepe's syncs (bridge.ingest):
//   bridge_spans(id, room_id, session, opened_at, last_seen, closed_at, close_reason: closed | left | timeout)
//   * a sync that carries the room (it is in rooms[] or an event is scoped to it) opens a span when none is open;
//   * the room in closed[] closes it now (closed), a room.left event too (left);
//   * 10 minutes without the room close it at last_seen + 10 min (timeout) - from the next sync that carries it (which then
//     opens a new span) or from the 60 s sweeper; open spans found at boot are left to those two;
//   * last_seen is written at most once a minute per room (kept exact in memory).
// Switch hubseam.spans (default ON - it only records and never affects the sync: note() is queued, never awaited by the sync,
// and its errors are logged). No reader is built yet; /admin/keys#seam shows the counts.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const GAP_MS = 10 * 60 * 1000;
const WRITE_EVERY_MS = 60 * 1000;
const SWEEP_MS = 60 * 1000;

let clock = () => Date.now();
const now = () => clock();
const open = new Map();                  // room_id -> {id, last_seen, written}
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS bridge_spans (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, session TEXT,
        opened_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, closed_at INTEGER, close_reason TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS bridge_spans_room ON bridge_spans (room_id, opened_at)");
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS bridge_spans_open ON bridge_spans (room_id) WHERE closed_at IS NULL");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const enabled = () => { try { return require("./huboutbox").on("spans"); } catch (e) { return false; } };
const rid = (v) => (typeof v === "string" ? v.trim().slice(0, 128) : "");

async function openRow(room) {
  let o = open.get(room);
  if (o) return o;
  const r = (await getQuery("SELECT id, last_seen FROM bridge_spans WHERE room_id = ? AND closed_at IS NULL", [room]))[0];
  if (r) { o = { id: r.id, last_seen: Number(r.last_seen), written: Number(r.last_seen) }; open.set(room, o); }
  return o || null;
}
async function close(room, at, reason) {
  const o = await openRow(room);
  open.delete(room);
  if (!o) return false;
  await runQuery("UPDATE bridge_spans SET closed_at = ?, close_reason = ?, last_seen = MAX(last_seen, ?) WHERE id = ? AND closed_at IS NULL",
                 [at, reason, Math.min(at, o.last_seen), o.id]);
  return true;
}
async function seen(room, session, t) {
  let o = await openRow(room);
  if (o && t - o.last_seen > GAP_MS) {                    // the room went quiet for > 10 min: that span ended back then
    await close(room, o.last_seen + GAP_MS, "timeout");
    o = null;
  }
  if (!o) {
    const r = await runQuery("INSERT INTO bridge_spans (room_id, session, opened_at, last_seen) VALUES (?, ?, ?, ?)",
                             [room, session ? String(session).slice(0, 64) : null, t, t]);
    open.set(room, { id: r.id, last_seen: t, written: t });
    return;
  }
  o.last_seen = t;
  if (t - o.written >= WRITE_EVERY_MS) {
    o.written = t;
    await runQuery("UPDATE bridge_spans SET last_seen = MAX(last_seen, ?) WHERE id = ?", [t, o.id]);
  }
}

/** One sync body (bridge.ingest) -> the spans it opens, extends or closes. */
async function apply(body, t) {
  if (!enabled() || !body || typeof body !== "object") return;
  await init();
  const closed = new Set((Array.isArray(body.closed) ? body.closed : []).map(rid).filter(Boolean));
  const left = new Set();
  const carried = new Set();
  for (const s of Array.isArray(body.rooms) ? body.rooms : []) { const id = rid(s && s.room && s.room.id); if (id) carried.add(id); }
  for (const ev of Array.isArray(body.events) ? body.events : []) {
    const id = rid(ev && ev.scope && ev.scope.room && ev.scope.room.id);
    if (!id) continue;
    if (ev.type === "room.left") left.add(id); else carried.add(id);
  }
  for (const id of closed) await close(id, t, "closed");
  for (const id of left) if (!carried.has(id)) await close(id, t, "left");
  for (const id of carried) if (!closed.has(id)) await seen(id, body.session, t);
}

let chain = Promise.resolve();
/** Queue one sync's spans (in order, never awaited by the sync; errors logged). -> the queued promise (tests await it). */
function note(body, t = now()) {
  chain = chain.then(() => apply(body, t)).catch((e) => console.error("[bridge_spans]", e.message));
  return chain;
}

/** Close open spans whose room has been silent for > 10 min, at last_seen + 10 min. */
async function sweep(t = now()) {
  if (!enabled()) return 0;
  await init();
  for (const [room, o] of open) if (t - o.last_seen > GAP_MS) await close(room, o.last_seen + GAP_MS, "timeout");
  const r = await runQuery(`UPDATE bridge_spans SET closed_at = last_seen + ?, close_reason = 'timeout'
                            WHERE closed_at IS NULL AND last_seen < ?${open.size ? ` AND room_id NOT IN (${[...open.keys()].map(() => "?").join(",")})` : ""}`,
                           [GAP_MS, t - GAP_MS, ...open.keys()]);
  return (r && r.changes) || 0;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { chain = chain.then(() => sweep()).catch((e) => console.error("[bridge_spans] sweep:", e.message)); }, SWEEP_MS);
  if (timer.unref) timer.unref();
}

async function stats(t = now()) {
  try {
    await init();
    const o = (await getQuery("SELECT COUNT(*) AS n FROM bridge_spans WHERE closed_at IS NULL"))[0] || {};
    const d = new Date(t); d.setUTCHours(0, 0, 0, 0);
    const today = (await getQuery("SELECT COUNT(*) AS n FROM bridge_spans WHERE opened_at >= ?", [d.getTime()]))[0] || {};
    return { open: o.n || 0, today: today.n || 0, on: enabled() };
  } catch (e) { return { open: 0, today: 0, on: enabled() }; }
}

module.exports = { init, note, apply, sweep, start, stats, GAP_MS, WRITE_EVERY_MS, _open: open, _setClock: (f) => { clock = f || (() => Date.now()); },
                   _settle: () => chain };
