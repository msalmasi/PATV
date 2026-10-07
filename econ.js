// econ.js — economy v2, phase E-0: measurement only (camfrog-bot docs/ECONOMY-V2.md, section 12).
// Nothing here moves PAT. Three feeds and one admin view:
//
//   POST /api/econ/charges        (bot)  every PAT flow Pepe routes, tagged with room, flow, kind,
//                                        payer, payer_kind and via (chat / pm / web / system) ->
//                                        econ_charges, a side table next to `transactions` (keyed by
//                                        the bot's ref, so a re-send is harmless). Negative = refund.
//   POST /api/econ/participation  (bot)  per room / day / Camfrog login: chat lines, mic minutes,
//                                        paid commands, active minutes -> econ_participation (upsert)
//   POST /api/econ/watch/beat     (site) the stage player's viewer heartbeat (every 30 s from a
//                                        signed-in viewer) -> econ_watch, watch-seconds per day /
//                                        stream / viewer. Credited only for consecutive beats from
//                                        ONE session per account, with the page visible, the video
//                                        playing and its position advancing. The streamer's own
//                                        account and accounts sharing a strong identity key with it
//                                        (welcome-bonus dedupe keys, dup_of) are excluded; viewers
//                                        sharing a browser (or > 3 sharing a network) on the same
//                                        stream are flagged as likely alts.
//   GET  /api/admin/econ/telemetry (admins) the last 7 days per room: revenue by flow, watch-minutes,
//                                        participants, and what the v2 50/50 split and the room-vault
//                                        recipe WOULD have paid (dry run of the doc's formulas).
//
// Flag: econ_config.economy_e0 (default on; read-only telemetry). Off = ingest and beats are
// accepted and dropped, the card says so.
"use strict";
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const guard = require("./middleware/authGuard");
const welcome = require("./welcome");

const DEFAULTS = { economy_e0: 1 };
const BEAT_MIN_MS = 20000;          // a beat sooner than this after the last counted one is ignored
const BEAT_MAX_MS = 45000;          // a gap longer than this restarts the session (no credit)
const BEAT_CREDIT_MAX = 30;         // seconds credited per beat
const POS_ADVANCE_MIN = 5;          // the media position must move at least this much between beats
const VWM_CAP_MIN = 120;            // per viewer per streamer per day (doc 7.2)
const IP_MAX = 3;                   // more accounts than this on one network for one stream -> flagged
const STRONG = ["cf", "discord", "twitch", "email", "dev"];

const day = (t) => new Date(t == null ? Date.now() : t).toISOString().slice(0, 10);
const int = (v, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v, max) => String(v == null ? "" : v).slice(0, max);
const ROOM_RE = /^[A-Za-z0-9._:-]{0,64}$/;
const LOGIN_RE = /^[A-Za-z0-9._-]{1,40}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const ready = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_config (k TEXT PRIMARY KEY, v TEXT)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_charges (ref TEXT PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL,
                  room_id TEXT NOT NULL DEFAULT '', flow TEXT NOT NULL, kind TEXT NOT NULL, payer TEXT, payer_kind TEXT,
                  amount INTEGER NOT NULL, via TEXT, received INTEGER)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS econ_charges_day ON econ_charges (day, room_id)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_participation (room_id TEXT NOT NULL, day TEXT NOT NULL, login TEXT NOT NULL,
                  lines INTEGER DEFAULT 0, mic_min REAL DEFAULT 0, cmds INTEGER DEFAULT 0, active_min INTEGER DEFAULT 0,
                  updated INTEGER, PRIMARY KEY (room_id, day, login))`);
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_watch (day TEXT NOT NULL, stream TEXT NOT NULL, room_id TEXT, streamer_id TEXT,
                  viewer_id TEXT NOT NULL, secs INTEGER DEFAULT 0, muted_secs INTEGER DEFAULT 0, beats INTEGER DEFAULT 0,
                  status TEXT DEFAULT 'ok', reason TEXT, updated INTEGER, PRIMARY KEY (day, stream, viewer_id))`);
  await runQuery(`CREATE INDEX IF NOT EXISTS econ_watch_room ON econ_watch (day, room_id)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_watch_keys (day TEXT NOT NULL, stream TEXT NOT NULL, k TEXT NOT NULL,
                  viewer_id TEXT NOT NULL, PRIMARY KEY (day, stream, k, viewer_id))`);
})().catch((e) => console.error("[econ] init:", e));

// ── config ──
let cfgCache = null;
async function config() {
  if (cfgCache) return cfgCache;
  await ready;
  const c = Object.assign({}, DEFAULTS);
  for (const r of await getQuery("SELECT k, v FROM econ_config")) if (r.k in DEFAULTS) c[r.k] = int(r.v, DEFAULTS[r.k]);
  cfgCache = c;
  return c;
}
async function setConfig(patch) {
  await ready;
  for (const k of Object.keys(DEFAULTS)) {
    if (patch && k in patch) await runQuery("INSERT INTO econ_config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, String(patch[k] ? 1 : 0)]);
  }
  cfgCache = null;
  return config();
}
const enabled = async () => !!(await config()).economy_e0;

// ── 1. charges ──
const KINDS = new Set(["room", "federal", "fine", "game"]);
const VIAS = new Set(["chat", "pm", "web", "system"]);
function cleanCharge(x) {
  if (!x || typeof x !== "object") return null;
  const ref = str(x.ref, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(ref)) return null;
  const amount = int(x.amount);
  if (!amount || Math.abs(amount) > 1e12) return null;
  const room = str(x.room, 64);
  if (!ROOM_RE.test(room)) return null;
  const flow = str(x.flow, 32).replace(/[^A-Za-z0-9_:.-]/g, "");
  if (!flow) return null;
  const ts = int(x.ts, Date.now());
  return {
    ref, ts, day: DAY_RE.test(String(x.day || "")) ? String(x.day) : day(ts), room, flow,
    kind: KINDS.has(x.kind) ? x.kind : "game", payer: LOGIN_RE.test(String(x.payer || "")) ? String(x.payer).toLowerCase() : "",
    payer_kind: x.payer_kind === "owner" ? "owner" : "other", amount, via: VIAS.has(x.via) ? x.via : "system",
  };
}
async function ingestCharges(items) {
  await ready;
  let saved = 0;
  const now = Date.now();
  for (const it of (Array.isArray(items) ? items : []).slice(0, 1000)) {
    const c = cleanCharge(it);
    if (!c) continue;
    const r = await runQuery(`INSERT OR IGNORE INTO econ_charges (ref, ts, day, room_id, flow, kind, payer, payer_kind, amount, via, received)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.ref, c.ts, c.day, c.room, c.flow, c.kind, c.payer, c.payer_kind, c.amount, c.via, now]);
    saved += r.changes || 0;
  }
  return saved;
}

// ── 2. participation ──
async function ingestParticipation(rows) {
  await ready;
  let saved = 0;
  const now = Date.now();
  for (const x of (Array.isArray(rows) ? rows : []).slice(0, 5000)) {
    if (!x || !ROOM_RE.test(String(x.room || "")) || !x.room || !DAY_RE.test(String(x.day || "")) || !LOGIN_RE.test(String(x.login || ""))) continue;
    await runQuery(`INSERT INTO econ_participation (room_id, day, login, lines, mic_min, cmds, active_min, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(room_id, day, login) DO UPDATE SET lines = MAX(lines, excluded.lines), mic_min = MAX(mic_min, excluded.mic_min),
                    cmds = MAX(cmds, excluded.cmds), active_min = MAX(active_min, excluded.active_min), updated = excluded.updated`,
      [x.room, x.day, String(x.login).toLowerCase(), Math.max(0, int(x.lines)), Math.max(0, Math.min(1440, num(x.mic_min))),
       Math.max(0, int(x.cmds)), Math.max(0, Math.min(1440, int(x.active_min))), now]);
    saved++;
  }
  return saved;
}

// ── 3. watch heartbeats ──
const sessions = new Map();                 // viewerId -> { sid, stream, t, pos }
let clock = () => Date.now();
const beatHits = guard.limiter({ max: 8, windowMs: 60000 });
const linkCache = new Map();                // `${viewer}|${streamer}` -> { at, status, reason }

async function strongKeys(userId) {
  const rows = await getQuery(`SELECT k FROM welcome_keys WHERE userId = ? AND kind IN (${STRONG.map(() => "?").join(",")})`, [userId, ...STRONG]);
  return new Set(rows.map((r) => r.k));
}
async function dupOf(userId) {
  try { const r = await getQuery("SELECT dup_of FROM welcome_bonus WHERE userId = ?", [userId]); return r[0] ? r[0].dup_of : null; } catch (e) { return null; }
}
// Is the viewer the streamer, or the same person by a strong key / the welcome dedupe? -> {status, reason}
async function relation(viewerId, streamerId) {
  if (!streamerId) return { status: "ok" };
  if (viewerId === streamerId) return { status: "self", reason: "the streamer" };
  const key = viewerId + "|" + streamerId;
  const hit = linkCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit;
  let out = { status: "ok" };
  try {
    const [a, b] = [await strongKeys(viewerId), await strongKeys(streamerId)];
    for (const k of a) if (b.has(k)) { out = { status: "self", reason: "shares the streamer's " + k.split(":")[0] }; break; }
    if (out.status === "ok") {
      const [da, db] = [await dupOf(viewerId), await dupOf(streamerId)];
      if (da === streamerId || db === viewerId) out = { status: "self", reason: "the streamer's duplicate account" };
    }
  } catch (e) { /* keys tables missing: treat as unrelated */ }
  linkCache.set(key, Object.assign({ at: Date.now() }, out));
  if (linkCache.size > 5000) linkCache.clear();
  return out;
}

// Request keys (browser + network), the same hashes the welcome dedupe uses.
function requestKeys(req, res) {
  const out = [];
  try {
    if (typeof welcome.reqKeys === "function") return welcome.reqKeys(req, res);
    const ip = welcome.normIp(guard.clientIp(req));
    if (ip) out.push(["ip", welcome.hash("ip", ip)]);
  } catch (e) { /* no keys */ }
  return out;
}

async function altCheck(d, stream, viewerId, keys) {
  if (!keys.length) return null;
  for (const [, k] of keys) {
    await runQuery("INSERT OR IGNORE INTO econ_watch_keys (day, stream, k, viewer_id) VALUES (?, ?, ?, ?)", [d, stream, k, viewerId]);
  }
  const dev = keys.filter(([kind]) => kind === "dev").map(([, k]) => k);
  if (dev.length) {
    const r = await getQuery(`SELECT COUNT(DISTINCT viewer_id) AS n FROM econ_watch_keys WHERE day = ? AND stream = ? AND k IN (${dev.map(() => "?").join(",")}) AND viewer_id != ?`,
      [d, stream, ...dev, viewerId]);
    if (r[0] && r[0].n > 0) return "same browser as another viewer";
  }
  const ip = keys.filter(([kind]) => kind === "ip").map(([, k]) => k);
  if (ip.length) {
    const r = await getQuery(`SELECT COUNT(DISTINCT viewer_id) AS n FROM econ_watch_keys WHERE day = ? AND stream = ? AND k IN (${ip.map(() => "?").join(",")})`,
      [d, stream, ...ip]);
    if (r[0] && r[0].n > IP_MAX) return `${r[0].n} accounts on one network`;
  }
  const dup = await dupOf(viewerId);
  if (dup) return "flagged by the welcome dedupe";
  return null;
}

// The pure session rule: how many seconds this beat earns, and the new session state.
//   prev  {sid, stream, t, pos} | undefined     beat {sid, stream, playing, visible, pos}
// -> { credit, why, next } (next undefined = keep prev)
function sessionStep(prev, beat, now) {
  if (!beat.playing || !beat.visible) {
    // a paused / hidden tab: no credit, and it disarms ITS session so the next beat starts fresh
    if (prev && prev.sid === beat.sid) return { credit: 0, why: beat.visible ? "paused" : "hidden", next: null };
    return { credit: 0, why: beat.visible ? "paused" : "hidden" };
  }
  if (prev && prev.sid !== beat.sid && now - prev.t < BEAT_MAX_MS) return { credit: 0, why: "another session" };
  const fresh = { sid: beat.sid, stream: beat.stream, t: now, pos: beat.pos };
  if (!prev || prev.sid !== beat.sid || prev.stream !== beat.stream) return { credit: 0, why: "started", next: fresh };
  const gap = now - prev.t;
  if (gap < BEAT_MIN_MS) return { credit: 0, why: "too soon" };
  if (gap > BEAT_MAX_MS) return { credit: 0, why: "gap", next: fresh };
  if (!(beat.pos >= prev.pos + POS_ADVANCE_MIN)) return { credit: 0, why: "not advancing", next: fresh };
  return { credit: Math.min(BEAT_CREDIT_MAX, Math.round(gap / 1000)), why: "counted", next: fresh };
}

let resolveRoomFn = null;
async function streamInfo(stream, roomSlug) {
  if (stream !== "pepe") {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(stream)) return null;
    let s;
    try { s = (await getQuery("SELECT id, userId, room_id, status, embed FROM stage_slots WHERE id = ?", [stream]))[0]; } catch (e) { return null; }
    if (!s || s.status !== "active" || (s.embed && String(s.embed).trim())) return null;   // embeds can't be verified
    return { stream: "slot:" + s.id, room_id: s.room_id || "", streamer_id: s.userId || null };
  }
  let roomId = "";
  try {
    if (resolveRoomFn) roomId = (await resolveRoomFn(roomSlug)) || "";
    else {
      const rooms = require("./rooms");
      const R = roomSlug ? await rooms.bySlug(roomSlug) : null;
      roomId = R ? R.id : rooms.HOUSE_ROOM;
    }
  } catch (e) { roomId = ""; }
  return { stream: "pepe:" + roomId, room_id: roomId, streamer_id: null };
}

async function beat(req, res) {
  const u = req.user && req.user.userId;
  if (!u) return { code: 401, body: { ok: false, error: "Sign in first." } };
  if (!(await enabled())) return { code: 200, body: { ok: true, counted: false, why: "off" } };
  if (beatHits.blocked(u)) return { code: 429, body: { ok: false, error: "slow down" } };
  beatHits.hit(u);
  const b = req.body || {};
  const sid = str(b.sid, 40);
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(sid)) return { code: 400, body: { ok: false, error: "bad session" } };
  const info = await streamInfo(str(b.stream, 40), str(b.room, 80));
  if (!info) return { code: 200, body: { ok: true, counted: false, why: "not a live stage stream" } };
  const now = clock();
  const step = sessionStep(sessions.get(u), { sid, stream: info.stream, playing: b.playing === true, visible: b.visible === true, pos: num(b.pos, -1) }, now);
  if (step.next === null) sessions.delete(u); else if (step.next) sessions.set(u, step.next);
  if (sessions.size > 20000) sessions.clear();
  if (!step.credit) return { code: 200, body: { ok: true, counted: false, why: step.why } };
  await ready;
  const d = day(now);
  const rel = await relation(u, info.streamer_id);
  let status = rel.status, reason = rel.reason || null;
  if (status === "ok") {
    const alt = await altCheck(d, info.stream, u, requestKeys(req, res));
    if (alt) { status = "alt"; reason = alt; }
  }
  const muted = b.muted === true ? step.credit : 0;
  // status only ever escalates for the day: ok -> alt -> self
  await runQuery(`INSERT INTO econ_watch (day, stream, room_id, streamer_id, viewer_id, secs, muted_secs, beats, status, reason, updated)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                  ON CONFLICT(day, stream, viewer_id) DO UPDATE SET secs = secs + excluded.secs, muted_secs = muted_secs + excluded.muted_secs,
                  beats = beats + 1, updated = excluded.updated,
                  status = CASE WHEN status = 'self' OR excluded.status = 'self' THEN 'self' WHEN status = 'alt' OR excluded.status = 'alt' THEN 'alt' ELSE 'ok' END,
                  reason = COALESCE(reason, excluded.reason)`,
    [d, info.stream, info.room_id, info.streamer_id, u, step.credit, muted, status, reason, now]);
  return { code: 200, body: { ok: true, counted: true, secs: step.credit, status } };
}

// ── dry run: the doc's formulas (ECONOMY-V2.md 5.1, 7.2, 7.3) ──
const RECIPE = { rate: 0.10, owner: 0.15, gang: 0.15, streamers: 0.25, participants: 0.35, games: 0.10,
                 inflowCap: 0.25, vwmRef: 600, peopleRef: 20 };
// One day's recipe on a budget B. opts: {ownerPresent, house, gangHolds, I7, vwm, qualified, gamesRan}
function recipe(B, o) {
  o = o || {};
  const cap = RECIPE.inflowCap * Math.max(0, num(o.I7));
  const owner = (!o.house && o.ownerPresent) ? Math.min(RECIPE.owner * B, cap) : 0;
  const gang = o.gangHolds ? Math.min(RECIPE.gang * B, cap) : 0;
  const streamers = RECIPE.streamers * B * Math.min(1, Math.max(0, num(o.vwm)) / RECIPE.vwmRef);
  const participants = RECIPE.participants * B * Math.min(1, Math.max(0, num(o.qualified)) / RECIPE.peopleRef);
  const games = o.gamesRan ? RECIPE.games * B : 0;
  const paid = owner + gang + streamers + participants + games;
  return { B, owner, gang, streamers, participants, games, paid, stays: B - paid };
}
// balance* = inflow / (rate x claimed fraction)
const equilibrium = (inflow, claimed, rate = RECIPE.rate) => (claimed > 0 ? inflow / (rate * claimed) : Infinity);
// The 50/50 rule (7.1) over charge rows: room flows split Fort Knox / room vault, except an owner's
// own spend (100% Fort Knox) and no-room spend; federal and fines are all Fort Knox; games aren't split.
function split5050(rows) {
  const out = { room_flow: 0, to_vault: 0, to_fortknox: 0, owner_self: 0, no_room: 0, federal: 0, fines: 0, games: 0 };
  for (const r of rows) {
    const a = num(r.amount);
    if (r.kind === "room") {
      out.room_flow += a;
      if (!r.room_id) { out.no_room += a; out.to_fortknox += a; }
      else if (r.payer_kind === "owner") { out.owner_self += a; out.to_fortknox += a; }
      else { out.to_vault += a / 2; out.to_fortknox += a / 2; }
    } else if (r.kind === "federal") { out.federal += a; out.to_fortknox += a; }
    else if (r.kind === "fine") { out.fines += a; out.to_fortknox += a; }
    else out.games += a;
  }
  return out;
}
// Run the recipe day by day from an empty vault. days: [{day, inflow, ownerPresent, vwm, qualified}]
function simulate(days, o) {
  o = o || {};
  let bal = num(o.start);
  const tot = { inflow: 0, owner: 0, gang: 0, streamers: 0, participants: 0, games: 0, paid: 0, budget: 0 };
  const I7 = days.length ? days.reduce((s, x) => s + num(x.inflow), 0) / days.length : 0;
  const per = [];
  for (const x of days) {
    bal += num(x.inflow);
    const r = recipe(RECIPE.rate * bal, { ownerPresent: x.ownerPresent, house: o.house, gangHolds: false, I7, vwm: x.vwm, qualified: x.qualified, gamesRan: false });
    bal -= r.paid;
    tot.inflow += num(x.inflow); tot.budget += r.B;
    for (const k of ["owner", "gang", "streamers", "participants", "games", "paid"]) tot[k] += r[k];
    per.push({ day: x.day, inflow: num(x.inflow), B: Math.round(r.B), paid: Math.round(r.paid), balance: Math.round(bal) });
  }
  const claimed = tot.budget > 0 ? tot.paid / tot.budget : 0;
  return { totals: tot, balance: bal, claimed, I7, equilibrium: equilibrium(I7, claimed), days: per, topup_ask: tot.paid };
}

// ── the admin view ──
async function telemetry(nDays = 7) {
  await ready;
  const cfg = await config();
  const now = Date.now();
  const days = [];
  for (let i = nDays - 1; i >= 0; i--) days.push(day(now - i * 86400000));
  const from = days[0];
  const charges = await getQuery(`SELECT day, room_id, flow, kind, payer_kind, via, SUM(amount) AS amount, COUNT(*) AS n FROM econ_charges
                                  WHERE day >= ? GROUP BY day, room_id, flow, kind, payer_kind, via`, [from]);
  const part = await getQuery(`SELECT room_id, day, login, lines, mic_min, cmds, active_min FROM econ_participation WHERE day >= ?`, [from]);
  const watch = await getQuery(`SELECT day, stream, room_id, streamer_id, viewer_id, secs, muted_secs, status FROM econ_watch WHERE day >= ?`, [from]);
  let rooms = null;
  try { rooms = require("./rooms"); } catch (e) { rooms = null; }
  const R = new Map();
  const get = (id) => {
    let r = R.get(id);
    if (!r) {
      let meta = null;
      try { meta = id && rooms ? rooms.getCached(id) : null; } catch (e) { meta = null; }
      r = { room_id: id, title: id ? ((meta && meta.title) || id) : "No room (website / PM-less)", house: !!(meta && meta.house),
            owner_login: meta && meta.owner && meta.owner.camfrog ? String(meta.owner.camfrog).toLowerCase() : null,
            revenue: { total: 0, by_flow: {}, by_kind: {}, by_via: {} }, rows: [],
            watch: { vwm: 0, alt_min: 0, self_min: 0, muted_min: 0, viewers: 0, streams: {} },
            people: { qualified_per_day: {}, unique: 0, lines: 0, mic_min: 0, active_min: 0 }, daily: {} };
      for (const d of days) r.daily[d] = { inflow: 0, vwm: 0, qualified: 0, ownerPresent: false };
      R.set(id, r);
    }
    return r;
  };
  for (const c of charges) {
    const r = get(c.room_id || "");
    const a = num(c.amount);
    r.revenue.total += a;
    r.revenue.by_flow[c.flow] = (r.revenue.by_flow[c.flow] || 0) + a;
    r.revenue.by_kind[c.kind] = (r.revenue.by_kind[c.kind] || 0) + a;
    r.revenue.by_via[c.via] = (r.revenue.by_via[c.via] || 0) + a;
    r.rows.push(c);
    if (c.room_id && c.kind === "room" && c.payer_kind !== "owner" && r.daily[c.day]) r.daily[c.day].inflow += a / 2;
  }
  // watch: VWM capped per viewer per streamer per day; alt / self kept apart
  const viewers = new Map();
  for (const w of watch) {
    if (!w.room_id) continue;
    const r = get(w.room_id);
    const min = Math.min(VWM_CAP_MIN, num(w.secs) / 60);
    if (w.status === "self") r.watch.self_min += num(w.secs) / 60;
    else if (w.status === "alt") r.watch.alt_min += num(w.secs) / 60;
    else {
      r.watch.vwm += min;
      if (r.daily[w.day]) r.daily[w.day].vwm += min;
      r.watch.streams[w.stream] = (r.watch.streams[w.stream] || 0) + min;
      if (!viewers.has(w.room_id)) viewers.set(w.room_id, new Set());
      viewers.get(w.room_id).add(w.viewer_id);
    }
    r.watch.muted_min += num(w.muted_secs) / 60;
  }
  for (const [id, s] of viewers) get(id).watch.viewers = s.size;
  // participants: >= 10 lines or >= 5 mic minutes in the room that day (doc 7.2)
  const uniq = new Map();
  for (const p of part) {
    const r = get(p.room_id);
    r.people.lines += num(p.lines); r.people.mic_min += num(p.mic_min); r.people.active_min += num(p.active_min);
    const q = num(p.lines) >= 10 || num(p.mic_min) >= 5;
    if (q) {
      r.people.qualified_per_day[p.day] = (r.people.qualified_per_day[p.day] || 0) + 1;
      if (r.daily[p.day]) r.daily[p.day].qualified += 1;
      if (!uniq.has(p.room_id)) uniq.set(p.room_id, new Set());
      uniq.get(p.room_id).add(p.login);
    }
    if (r.owner_login && p.login === r.owner_login && r.daily[p.day]) r.daily[p.day].ownerPresent = true;
  }
  for (const [id, s] of uniq) get(id).people.unique = s.size;
  const out = [];
  for (const r of R.values()) {
    const split = split5050(r.rows);
    const sim = r.room_id ? simulate(days.map((d) => Object.assign({ day: d }, r.daily[d])), { house: r.house }) : null;
    const qd = Object.values(r.people.qualified_per_day);
    out.push({
      room_id: r.room_id, title: r.title, house: r.house,
      revenue: r.revenue, split,
      watch: { vwm: Math.round(r.watch.vwm), alt_min: Math.round(r.watch.alt_min), self_min: Math.round(r.watch.self_min),
               muted_min: Math.round(r.watch.muted_min), viewers: r.watch.viewers,
               streams: Object.fromEntries(Object.entries(r.watch.streams).map(([k, v]) => [k, Math.round(v)])) },
      people: { qualified_avg: qd.length ? Math.round(qd.reduce((s, x) => s + x, 0) / nDays * 10) / 10 : 0, unique: r.people.unique,
                lines: r.people.lines, mic_min: Math.round(r.people.mic_min), active_min: r.people.active_min },
      dryrun: sim && {
        inflow: Math.round(sim.totals.inflow), paid: Math.round(sim.totals.paid), balance: Math.round(sim.balance),
        slices: { owner: Math.round(sim.totals.owner), gang: 0, streamers: Math.round(sim.totals.streamers),
                  participants: Math.round(sim.totals.participants), games: 0 },
        claimed: Math.round(sim.claimed * 1000) / 1000, equilibrium: Number.isFinite(sim.equilibrium) ? Math.round(sim.equilibrium) : null,
        topup_ask: Math.round(sim.topup_ask), days: sim.days,
      },
    });
  }
  out.sort((a, b) => (b.revenue.total - a.revenue.total) || String(a.room_id).localeCompare(String(b.room_id)));
  const all = split5050(charges);
  return { ok: true, enabled: !!cfg.economy_e0, days, rooms: out,
           totals: { revenue: charges.reduce((s, c) => s + num(c.amount), 0), split: all },
           recipe: RECIPE, notes: { burn_reserve: 0 } };
}

async function isAdmin(req) {
  if (!req.user || !req.user.userId) return false;
  const u = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]))[0];
  return !!(u && u.class === "Admin");
}

function register(app, { isBotToken, addUser, resolveRoom } = {}) {
  if (resolveRoom) resolveRoomFn = resolveRoom;
  const big = express.json({ limit: "2mb" });
  app.post("/api/econ/charges", big, async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      if (!(await enabled())) return res.json({ ok: true, saved: 0, off: true });
      res.json({ ok: true, saved: await ingestCharges(body.items) });
    } catch (e) { console.error("[econ] charges:", e); res.status(500).json({ ok: false, error: "ingest failed" }); }
  });
  app.post("/api/econ/participation", big, async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      if (!(await enabled())) return res.json({ ok: true, saved: 0, off: true });
      res.json({ ok: true, saved: await ingestParticipation(body.rows) });
    } catch (e) { console.error("[econ] participation:", e); res.status(500).json({ ok: false, error: "ingest failed" }); }
  });
  app.post("/api/econ/watch/beat", addUser, async (req, res) => {
    try {
      if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
      const r = await beat(req, res);
      res.status(r.code).json(r.body);
    } catch (e) { console.error("[econ] beat:", e); res.status(500).json({ ok: false }); }
  });
  app.get("/api/admin/econ/telemetry", addUser, async (req, res) => {
    try {
      if (!(await isAdmin(req))) return res.status(403).json({ ok: false, error: "admins only" });
      res.set("Cache-Control", "no-store");
      res.json(await telemetry(Math.max(1, Math.min(30, int(req.query.days, 7)))));
    } catch (e) { console.error("[econ] telemetry:", e); res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post("/api/admin/econ/config", addUser, async (req, res) => {
    try {
      if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
      if (!(await isAdmin(req))) return res.status(403).json({ ok: false, error: "admins only" });
      res.json({ ok: true, config: await setConfig(req.body || {}) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

module.exports = { register, ready, config, setConfig, ingestCharges, ingestParticipation, sessionStep, recipe, equilibrium,
  split5050, simulate, telemetry, relation, RECIPE, VWM_CAP_MIN,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { sessions.clear(); linkCache.clear(); cfgCache = null; } };
