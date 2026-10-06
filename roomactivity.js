// roomactivity.js — a rolling, in-memory tally of what PEOPLE are doing in each bridged room right
// now (1.99cj), for the homepage's automatic room pick (frontroom.js / rooms.frontRoom).
//
// Fed by bridge.js ingest:
//   line(room, user, t)        a public chat line (msg)              -> lines + unique chatters
//   spoke(room, user, t)       a mic transcript line (tx)            -> counts as mic activity (lastAt)
//   micSample(room, holders, t) the room snapshot's mic holders      -> mic-milliseconds since the last sample
//   micHeld(room, user, ms, t) a finished mic hold (restart backfill from the persisted feed)
// Read by stats(room, {windowMin, now}) -> {chatters, lines, micMin, lastAt}.
//
// Bots never count: anything Pepe flags is_bot / is_self (Pepe himself), plus any login listed in
// PEPE_LOGINS (comma separated) as a belt-and-braces. Opted-out users ("someone") count as people
// but not as named chatters (they're one anonymous chatter per minute bucket at most).
// Kept per room: one bucket per minute for KEEP_MIN minutes. Nothing is written to disk - after a
// restart bridge.js replays the persisted feed (the last ~200 items per room) through here.
"use strict";

const MIN = 60 * 1000;
const KEEP_MIN = 90;                 // buckets kept (the score window is at most this)
const MIC_GAP_MAX = 60 * 1000;       // a snapshot gap longer than this only counts this much mic time
const EXTRA_BOTS = new Set(String(process.env.PEPE_LOGINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

const rooms = new Map();             // room id -> {b: Map(minute -> {lines, chat:Set, micMs}), lastAt, micAt}

function isHuman(u) {
  if (!u || typeof u !== "object") return false;
  if (u.bot || u.self || u.is_bot || u.is_self) return false;
  if (u.login && EXTRA_BOTS.has(String(u.login).toLowerCase())) return false;
  return true;
}
const keyOf = (u) => (u.anon ? "~anon" : String(u.login || u.display || "").toLowerCase());

function room(id) {
  let r = rooms.get(id);
  if (!r) { r = { b: new Map(), lastAt: 0, micAt: 0 }; rooms.set(id, r); }
  return r;
}
function bucket(r, t) {
  const m = Math.floor(t / MIN);
  let k = r.b.get(m);
  if (!k) {
    k = { lines: 0, chat: new Set(), micMs: 0 };
    r.b.set(m, k);
    const floor = m - KEEP_MIN;
    for (const key of r.b.keys()) if (key < floor) r.b.delete(key);
  }
  return k;
}

function line(roomId, user, t = Date.now()) {
  if (!isHuman(user)) return false;
  const r = room(roomId);
  const k = bucket(r, t);
  k.lines++;
  k.chat.add(keyOf(user));
  r.lastAt = Math.max(r.lastAt, t);
  return true;
}
function spoke(roomId, user, t = Date.now()) {
  if (!isHuman(user)) return false;
  const r = room(roomId);
  r.lastAt = Math.max(r.lastAt, t);
  return true;
}
/** Snapshot sampling: everyone (human) holding the mic now has held it since the last sample. */
function micSample(roomId, holders, t = Date.now()) {
  const r = room(roomId);
  const n = (Array.isArray(holders) ? holders : []).filter(isHuman).length;
  const dt = r.micAt ? Math.max(0, Math.min(MIC_GAP_MAX, t - r.micAt)) : 0;
  r.micAt = t;
  if (!n) return 0;
  bucket(r, t).micMs += dt * n;
  r.lastAt = Math.max(r.lastAt, t);
  return n;
}
function micHeld(roomId, user, ms, t = Date.now()) {
  if (!isHuman(user) || !(ms > 0)) return false;
  const r = room(roomId);
  bucket(r, t).micMs += Math.min(ms, KEEP_MIN * MIN);
  r.lastAt = Math.max(r.lastAt, t);
  return true;
}

/** People who aren't bots: the headcount minus listed bots / Pepe (Pepe is always there, listed or not). */
function people(count, members) {
  const list = Array.isArray(members) ? members : [];
  const bots = list.filter((u) => !isHuman(u)).length;
  const selfListed = list.some((u) => u && (u.self || u.is_self));
  return Math.max(0, (Number(count) || 0) - bots - (selfListed ? 0 : 1));
}

function stats(roomId, { windowMin = 20, now = Date.now() } = {}) {
  const r = rooms.get(roomId);
  const out = { chatters: 0, lines: 0, micMin: 0, lastAt: r && r.lastAt ? r.lastAt : null };
  if (!r) return out;
  const from = Math.floor((now - windowMin * MIN) / MIN), to = Math.floor(now / MIN);
  const who = new Set();
  let micMs = 0;
  for (const [m, k] of r.b) {
    if (m <= from || m > to) continue;
    out.lines += k.lines;
    micMs += k.micMs;
    for (const c of k.chat) who.add(c);
  }
  out.chatters = who.size;
  out.micMin = Math.round(micMs / 6000) / 10;
  return out;
}

function drop(roomId) { rooms.delete(roomId); }
function _reset() { rooms.clear(); }

module.exports = { line, spoke, micSample, micHeld, people, stats, drop, isHuman, _reset };
