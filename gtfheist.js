// gtfheist.js — 1.99zh: 📺 the LIVE HEIST page (/gtf/heist) - the heist overlay Pepe shows on OBS, on PATV, with a summary of the
// heist running now (camfrog-bot pepe_heistlive.py, bot 1.99zg). Linked from Pepe's heist start line and the /gtf minimap.
//
// The overlay is NOT re-implemented here: Pepe uploads his own OBS overlay page (pepe-avatar.html, the file OBS shows) when it
// changes, the site serves it at /gtf/heist/overlay and the page frames it as ?view=games&feed=/api/gtf/heist/live - in feed
// mode that page polls the feed below instead of Pepe's local WebSocket and plays the same events through the same handler.
//
//   POST /api/gtf/bot/heistlive     (Pepe, bot token) {events: [{event: heist|lobby|state, data, t}], lines: [{t, text}],
//                                   summary, kind} - one heist at a time; a new session (lobby) starts a fresh log
//   POST /api/gtf/bot/overlay/have  (Pepe) {sha} -> {have}
//   POST /api/gtf/bot/overlay       (Pepe) {sha, html} - the overlay page (<= 2 MB, sha256-checked)
//   GET  /api/gtf/heist/live?since=<id>  public: {events newer than id (the first call: only the current scene), last, summary,
//                                   lines (the run's chat lines), ended, at}
//   GET  /gtf/heist                 the page;  GET /gtf/heist/overlay  Pepe's overlay page (same-origin frame)
//
// Display only - nothing here moves PAT or decides anything. State is in memory + one row (gtf_heist_live) so a site restart
// keeps the page; the overlay is one row (gtf_overlay).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const EV_KEEP = 200, LINES_KEEP = 80, OVERLAY_MAX = 2 * 1024 * 1024;
const ENDED_SHOW_MS = 15 * 60e3;          // how long a finished heist's summary stays on the page
const STALE_MS = 10 * 60e3;               // a heist Pepe hasn't updated for this long is shown as over
const SCENES = new Set(["start", "round", "vault", "getaway", "closed"]);
const ACTIONS = new Set(["start", "round", "rolls", "vault", "crack", "getaway", "closed", "timer"]);   // 1.99aad: + timer (the countdown)
const now = () => Date.now();

let ready = null;
function init() {
  if (!ready) {
    ready = runQuery("CREATE TABLE IF NOT EXISTS gtf_heist_live (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated INTEGER NOT NULL)")
      .then(() => runQuery("CREATE TABLE IF NOT EXISTS gtf_overlay (id INTEGER PRIMARY KEY CHECK (id = 1), sha TEXT NOT NULL, html TEXT NOT NULL, updated INTEGER NOT NULL)"))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

let S = null;                             // {session, summary, events: [{id, event, data, t}], lines, nextId, ended, updated}
async function state() {
  if (S) return S;
  await init();
  const r = (await getQuery("SELECT data FROM gtf_heist_live WHERE id = 1").catch(() => []))[0];
  try { S = r ? JSON.parse(r.data) : null; } catch (e) { S = null; }
  if (!S || typeof S !== "object") S = { session: null, summary: null, events: [], lines: [], nextId: 1, ended: null, updated: 0 };
  return S;
}
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    runQuery("INSERT INTO gtf_heist_live (id, data, updated) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
             [JSON.stringify(S), now()]).catch((e) => console.error("[gtfheist] save:", e.message));
  }, 1500);
  if (saveTimer.unref) saveTimer.unref();
}

// ── cleaning what Pepe sends (the page renders it; the overlay escapes names itself) ──
const str = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f]/g, " ").slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : 0);
function cleanData(d, depth = 0) {
  if (depth > 5) return null;
  if (Array.isArray(d)) return d.slice(0, 60).map((x) => cleanData(x, depth + 1));
  if (d && typeof d === "object") {
    const o = {};
    for (const [k, v] of Object.entries(d).slice(0, 40)) {
      if (!/^[A-Za-z0-9_]{1,30}$/.test(k)) continue;
      o[k] = cleanData(v, depth + 1);
    }
    return o;
  }
  if (typeof d === "string") return d.slice(0, 300);
  if (typeof d === "number" || typeof d === "boolean" || d === null) return d;
  return null;
}
function cleanSummary(s) {
  if (!s || typeof s !== "object") return null;
  const phase = ["lobby", "running"].includes(s.phase) ? s.phase : "running";
  return {
    session: str(s.session, 40), phase, job: str(s.job, 20), scenario: str(s.scenario, 60), emoji: str(s.emoji, 8), blurb: str(s.blurb, 160),
    rounds: num(s.rounds), round: num(s.round), buyin: num(s.buyin), door: !!s.door, room: str(s.room, 60), started_by: str(s.started_by, 40),
    lobby_ends: s.lobby_ends ? num(s.lobby_ends) : null, prize: s.prize == null ? null : num(s.prize),
    crew: (Array.isArray(s.crew) ? s.crew : []).slice(0, 40).map((c) => ({
      name: str(c && c.name, 40) || "?", seed: c && c.seed != null ? (typeof c.seed === "number" ? c.seed : str(c.seed, 40)) : null,
      status: ["in", "out", "bailed"].includes(c && c.status) ? c.status : "in", held: Math.max(0, num(c && c.held)) })),
  };
}

/** Pepe's update. */
async function push(b) {
  const st = await state();
  const t = now();
  const summ = cleanSummary(b && b.summary);
  if (summ && summ.session && summ.session !== st.session) {
    // a new heist: a fresh log (the last one's end stays visible until this one starts)
    st.session = summ.session; st.events = []; st.lines = []; st.ended = null; st.summary = null;
  }
  if (summ) st.summary = summ;
  for (const e of (Array.isArray(b && b.events) ? b.events : []).slice(0, 40)) {
    if (!e || !["heist", "lobby", "state"].includes(e.event)) continue;
    const data = cleanData(e.data);
    if (e.event === "heist" && !(data && ACTIONS.has(data.action))) continue;
    st.events.push({ id: st.nextId++, event: e.event, data, t: num(e.t) || t });
    if (e.event === "heist" && data.action === "closed") st.ended = st.ended || t;
    if (e.event === "state" && data && (data.kind === "cancelled" || data.kind === "closed")) st.ended = st.ended || t;
  }
  if (b && (b.kind === "closed" || b.kind === "cancelled")) {
    st.ended = st.ended || t;
    if (b.kind === "cancelled" && st.summary) st.summary.phase = "cancelled";
  }
  if (st.events.length > EV_KEEP) st.events = st.events.slice(-EV_KEEP);
  for (const l of (Array.isArray(b && b.lines) ? b.lines : []).slice(0, 60)) {
    const text = str(l && l.text, 500);
    if (text) st.lines.push({ t: num(l.t) || t, text });
  }
  if (st.lines.length > LINES_KEEP) st.lines = st.lines.slice(-LINES_KEEP);
  st.updated = t;
  saveSoon();
  return { ok: true, overlay: await hasOverlay() };
}

/** The feed. since = the last event id the page has (0 = first call: only the current scene). */
async function live(since) {
  const st = await state();
  const t = now();
  const stale = st.updated && t - st.updated > STALE_MS;
  const ended = st.ended || (stale ? st.updated : null);
  const show = !!st.session && (!ended || t - ended < ENDED_SHOW_MS);
  let events = [];
  const s = Math.max(0, num(since));
  if (show) {
    if (s > 0) events = st.events.filter((e) => e.id > s);
    else {
      // the current scene: from the last scene-setting heist event (start / round / vault / getaway), or the lobby
      let i = -1;
      for (let k = st.events.length - 1; k >= 0; k--) {
        const e = st.events[k];
        if (e.event === "heist" && SCENES.has(e.data && e.data.action)) { i = k; break; }
        if (e.event === "lobby" && i < 0) { i = k; break; }
      }
      events = i >= 0 ? st.events.slice(i) : [];
    }
  }
  const last = st.events.length ? st.events[st.events.length - 1].id : 0;
  return {
    ok: true, now: t, at: st.updated || null, last,
    heist: show ? { session: st.session, summary: st.summary, ended, lines: st.lines.slice(-40) } : null,
    events: events.filter((e) => e.event !== "state").map((e) => ({ id: e.id, event: e.event, data: e.data })),
  };
}

// ── the overlay page ──
let overlaySha = undefined;
async function hasOverlay(sha) {
  await init();
  if (overlaySha === undefined) {
    const r = (await getQuery("SELECT sha FROM gtf_overlay WHERE id = 1").catch(() => []))[0];
    overlaySha = r ? r.sha : null;
  }
  return sha ? overlaySha === sha : !!overlaySha;
}
async function putOverlay(sha, html) {
  await init();
  if (typeof html !== "string" || !html || Buffer.byteLength(html, "utf8") > OVERLAY_MAX) throw Object.assign(new Error("bad overlay"), { status: 400 });
  const got = crypto.createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex");
  if (got !== String(sha || "")) throw Object.assign(new Error("sha mismatch"), { status: 400 });
  if (!/^<!DOCTYPE html>/i.test(html.trimStart())) throw Object.assign(new Error("not an html page"), { status: 400 });
  await runQuery("INSERT INTO gtf_overlay (id, sha, html, updated) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sha = excluded.sha, html = excluded.html, updated = excluded.updated",
                 [got, html, now()]);
  overlaySha = got;
  console.log(`[gtfheist] overlay page updated (${got.slice(0, 12)}, ${Buffer.byteLength(html, "utf8")} bytes)`);
  return { ok: true };
}
async function overlayHtml() {
  await init();
  const r = (await getQuery("SELECT html FROM gtf_overlay WHERE id = 1").catch(() => []))[0];
  return r ? r.html : null;
}

function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[gtfheist] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); }
    catch (e) { if (!e.status) console.error("[gtfheist]", e); res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "server_error" }); }
  };
  app.post("/api/gtf/bot/heistlive", bot((b) => push(b)));
  app.post("/api/gtf/bot/overlay/have", bot(async (b) => ({ ok: true, have: await hasOverlay(String(b.sha || "")) })));
  // the overlay page is ~240 KB: its own body limit (index.js skips the global JSON parser for it)
  app.post("/api/gtf/bot/overlay", require("express").json({ limit: "4mb" }), bot((b) => putOverlay(b.sha, b.html)));
  app.get("/api/gtf/heist/live", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await live(req.query.since)); } catch (e) { res.status(500).json({ ok: false }); }
  });
  app.get("/gtf/heist/overlay", async (req, res) => {
    const html = await overlayHtml().catch(() => null);
    res.set("Cache-Control", "no-cache");
    res.set("X-Frame-Options", "SAMEORIGIN");
    if (!html) return res.status(404).type("html").send("<!DOCTYPE html><meta charset=utf-8><body style='background:transparent'></body>");
    res.type("html").send(html);
  });
  app.get("/gtf/heist", addUser, async (req, res) => {
    let first = null;
    try { first = await live(0); } catch (e) { first = null; }
    res.render("gtfHeist", { user: req.user ? req.user.username : null, first });
  });
}

module.exports = { register, push, live, putOverlay, hasOverlay, cleanSummary, _reset: () => { S = null; overlaySha = undefined; } };
