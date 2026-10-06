// roomdj.js — Pepe's music / Auto-DJ on the room pages (1.99ba).
//
// Pepe (pepe_roomdj.py) pushes the DJ state for the bridged rooms that actually hear his music:
//   POST /api/dj/sync    {password, rooms: [{id, name, queue, play, pause, talk, price: {queue}}],
//                         state: {connected, at, now, queue[], dj: {on, vibe, genre}, drop, votes, max_pending},
//                         admins: {dj: [logins], music: [logins]}}      -> {ok, watching: [room ids]}
//   POST /api/dj/result  {password, id, results: [{n, title, artist, album, art}]}   (a website !find's list)
// The admin lists only decide which buttons a viewer sees (never sent to a browser); Pepe re-checks
// everything when the action runs.
//
// The room page's DJ panel (views/partials/room-dj.ejs + public/js/room-dj.js):
//   GET  /api/rooms/:slug/dj            the panel state + what this viewer may do (signed in)
//   POST /api/rooms/:slug/dj            {verb, text} -> a "dj" website action (linked Camfrog name;
//                                       JSON + X-Requested-With: fetch only, so a cross-site form can't)
//   GET  /api/rooms/:slug/dj/act/:id    that action's status + Pepe's reply (+ the search results)
// Every action is the chat command run AS the user in that room (actions.js -> Pepe's webact queue),
// so the PAT price, votes, cooldowns, DJ bans and roles are exactly the chat ones.
"use strict";
const { getQuery } = require("./dbUtils");

const STALE_MS = 90 * 1000;          // no sync for this long -> the panel hides
const WATCH_MS = 60 * 1000;          // a page polled this recently counts as watching
const RESULT_KEEP_MS = 30 * 60 * 1000;
const MAX_ROOMS = 20, MAX_QUEUE = 12, MAX_RESULTS = 10, MAX_ADMINS = 200;

// verb -> who may ask for it from the page. Pepe decides in the end; this only keeps the
// admin-only buttons (and their requests) away from everyone else.
const VERBS = {
  find: "all", pick: "all", skip: "all", pause: "all", resume: "all", play: "all", remove: "all", vibe: "all",
  "dj.on": "dj", "dj.off": "dj", "dj.next": "dj", "dj.talk.on": "dj", "dj.talk.off": "dj", "dj.vibe.clear": "dj", "dj.clear": "dj",
};
const LABELS = {
  find: (t) => "🔎 search: " + t, pick: (t) => "➕ queue #" + t, skip: () => "⏭️ skip", pause: () => "⏸️ pause",
  resume: () => "▶️ resume", play: () => "▶️ start the music", remove: () => "🗑️ remove my last request",
  vibe: (t) => "🎧 vibe: " + t, "dj.on": () => "🎧 Auto-DJ on", "dj.off": () => "🎧 Auto-DJ off", "dj.next": () => "🎧 Pepe picks next",
  "dj.talk.on": () => "🎙️ DJ talk on", "dj.talk.off": () => "🎙️ DJ talk off", "dj.vibe.clear": () => "🎧 clear the vibe bias",
  "dj.clear": () => "🧼 reset the DJ session",
};

// ── sanitising (Pepe already cleans; this is the second line) ──
const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const str = (v, n) => String(v == null ? "" : v).replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, n);
const int = (v, lo = 0, hi = 1e13) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const ART_RE = /^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]{8,64}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const art = (u) => (typeof u === "string" && ART_RE.test(u) ? u : null);

function cleanTrack(t, withProgress) {
  if (!t || typeof t !== "object") return null;
  const out = { title: str(t.title, 120), artist: str(t.artist, 120), by: ["user", "dj", "spotify"].includes(t.by) ? t.by : "spotify" };
  if (!out.title) return null;
  if (t.by === "user" && t.who) out.who = str(t.who, 40) || "someone";
  if (t.album) out.album = str(t.album, 120);
  const a = art(t.art);
  if (a) out.art = a;
  if (t.removed) out.removed = true;
  if (withProgress) {
    out.playing = !!t.playing;
    out.duration_ms = int(t.duration_ms, 0, 6 * 3600 * 1000);
    out.progress_ms = Math.min(int(t.progress_ms, 0, 6 * 3600 * 1000), out.duration_ms || 6 * 3600 * 1000);
  }
  return out;
}

function cleanState(s) {
  if (!s || typeof s !== "object") return null;
  const out = { connected: !!s.connected, at: int(s.at) || Date.now(), now: cleanTrack(s.now, true),
                queue: (Array.isArray(s.queue) ? s.queue : []).slice(0, MAX_QUEUE).map((t) => cleanTrack(t, false)).filter(Boolean) };
  const dj = s.dj && typeof s.dj === "object" ? s.dj : {};
  out.dj = { on: !!dj.on, clear: !!dj.clear, hold: !!dj.hold };
  if (dj.vibe && dj.vibe.text) out.dj.vibe = { text: str(dj.vibe.text, 140), by: str(dj.vibe.by, 40) || "someone", until: int(dj.vibe.until) };
  if (dj.genre) out.dj.genre = str(dj.genre, 80);
  if (s.drop && s.drop.text) out.drop = { text: str(s.drop.text, 300), ts: int(s.drop.ts) };
  const v = s.votes || {};
  out.votes = { start: int(v.start, 1, 20) || 4, stop: int(v.stop, 1, 20) || 2 };
  out.maxPending = int(s.max_pending, 1, 20) || 2;
  return out;
}

function cleanRoom(r) {
  if (!r || typeof r !== "object") return null;
  const id = str(r.id, 128);
  if (!id) return null;
  return { id, name: str(r.name, 60) || id, queue: r.queue !== false, play: r.play !== false, pause: r.pause !== false,
           talk: r.talk !== false, price: { queue: int((r.price || {}).queue, 0, 1e12) } };
}

// ── state ──
const S = { at: 0, state: null, rooms: new Map(), admins: { dj: new Set(), music: new Set() } };
const WATCH = new Map();             // room id -> last poll
const RESULTS = new Map();           // action id -> {results, at}

function ingest(body) {
  const rooms = (Array.isArray(body.rooms) ? body.rooms : []).slice(0, MAX_ROOMS).map(cleanRoom).filter(Boolean);
  S.rooms = new Map(rooms.map((r) => [r.id, r]));
  S.state = rooms.length ? cleanState(body.state) : null;
  const ad = body.admins || {};
  const set = (a) => new Set((Array.isArray(a) ? a : []).slice(0, MAX_ADMINS).map((x) => String(x).toLowerCase()).filter((x) => LOGIN_RE.test(x)));
  S.admins = { dj: set(ad.dj), music: set(ad.music) };
  S.at = Date.now();
  return { rooms: rooms.length };
}

/** The DJ room behind a bridged room, or null (not a music room / Pepe hasn't reported lately). */
function djRoom(id) {
  if (!S.state || Date.now() - S.at > STALE_MS) return null;
  return S.rooms.get(id) || null;
}

function watching() {
  const now = Date.now(), out = [];
  for (const [id, at] of WATCH) {
    if (now - at < WATCH_MS) out.push(id); else WATCH.delete(id);
  }
  return out;
}

function pruneResults() {
  const now = Date.now();
  for (const [id, r] of RESULTS) if (now - r.at > RESULT_KEEP_MS) RESULTS.delete(id);
  while (RESULTS.size > 500) RESULTS.delete(RESULTS.keys().next().value);
}

function defaultBySlug(slug) {
  const bridge = require("./bridge");
  const s = String(slug || "").toLowerCase();
  for (const R of bridge._rooms.values()) if (R.slug === s || bridge.slugify(R.id) === s) return R;
  return null;
}

async function viewer(req) {
  if (!req.user || !req.user.userId) return null;
  const u = (await getQuery("SELECT username, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
  if (!u) return null;
  const cf = String(u.camfrogUsername || "").toLowerCase();
  return { userId: req.user.userId, camfrog: cf || null, djAdmin: !!cf && S.admins.dj.has(cf), musicAdmin: !!cf && S.admins.music.has(cf) };
}

/** What a signed-in viewer's panel shows. */
async function panelFor(R, me) {
  const room = R ? djRoom(R.id) : null;
  if (!room) return { active: false };
  const st = S.state;
  let acts = [];
  if (me) {
    acts = await getQuery("SELECT id, label, status, message, created FROM pepe_actions WHERE user_id = ? AND tag = ? ORDER BY id DESC LIMIT 5",
      [me.userId, "dj:" + R.id]).catch(() => []);
  }
  return {
    active: true, age: Math.max(0, Date.now() - S.at),   // the page runs the progress bar on from here
    room: { queue: room.queue, play: room.play, pause: room.pause, talk: room.talk, price: room.price },
    state: st,
    me: { linked: !!(me && me.camfrog), djAdmin: !!(me && me.djAdmin), musicAdmin: !!(me && me.musicAdmin) },
    acts: acts.map((a) => ({ id: a.id, label: a.label, status: a.status, message: a.message || "" })),
  };
}

function register(app, { isBotToken, addUser, bySlug = defaultBySlug }) {
  app.post("/api/dj/sync", async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const r = ingest(body);
      res.json({ ok: true, ...r, watching: watching() });
    } catch (e) {
      console.error("[roomdj] sync:", e);
      res.status(500).json({ ok: false, error: "sync failed" });
    }
  });

  app.post("/api/dj/result", async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    const id = int(body.id, 0, 1e12);
    if (!id) return res.status(400).json({ ok: false, error: "no id" });
    const results = (Array.isArray(body.results) ? body.results : []).slice(0, MAX_RESULTS).map((t, i) => {
      if (!t || typeof t !== "object") return null;
      const o = { n: int(t.n, 1, MAX_RESULTS) || i + 1, title: str(t.title, 120), artist: str(t.artist, 120) };
      if (t.album) o.album = str(t.album, 120);
      const a = art(t.art);
      if (a) o.art = a;
      return o.title ? o : null;
    }).filter(Boolean);
    RESULTS.set(id, { results, at: Date.now() });
    pruneResults();
    res.json({ ok: true });
  });

  app.get("/api/rooms/:slug/dj", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ error: "Sign in to see the DJ." });
    const R = bySlug(req.params.slug);
    if (!R) return res.status(404).json({ error: "No such room." });
    WATCH.set(R.id, Date.now());
    res.json(await panelFor(R, await viewer(req)));
  });

  app.post("/api/rooms/:slug/dj", addUser, async (req, res) => {
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch") return res.status(400).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const R = bySlug(req.params.slug);
    if (!R) return res.status(404).json({ ok: false, error: "No such room." });
    const room = djRoom(R.id);
    if (!room) return res.status(409).json({ ok: false, error: "The music isn't on in this room right now." });
    const me = await viewer(req);
    if (!me || !me.camfrog) return res.status(403).json({ ok: false, error: "Link your Camfrog name first: type !verify in a room with Pepe." });
    const b = req.body || {};
    const verb = String(b.verb || "");
    const who = Object.prototype.hasOwnProperty.call(VERBS, verb) ? VERBS[verb] : null;
    if (!who) return res.status(400).json({ ok: false, error: "That can't be done from the site." });
    if (who === "dj" && !me.djAdmin) return res.status(403).json({ ok: false, error: "DJ controls are for Pepe's admins." });
    let text = str(b.text, verb === "find" ? 100 : 140);
    if (verb === "find" && !text) return res.status(400).json({ ok: false, error: "Type a song to search for." });
    if (verb === "vibe" && !text) return res.status(400).json({ ok: false, error: "Tell Pepe what you want to hear." });
    if (verb === "pick" && !/^\d{1,2}$/.test(text)) return res.status(400).json({ ok: false, error: "Pick a number from the list." });
    if (!["find", "pick", "vibe"].includes(verb)) text = "";
    try {
      const id = await require("./actions").queue(req.user.userId, { kind: "dj", args: text ? [R.id, verb, text] : [R.id, verb],
        tag: "dj:" + R.id, label: LABELS[verb](text) });
      res.json({ ok: true, id });
    } catch (e) {
      res.status(e.message === "busy" ? 429 : 500).json({ ok: false,
        error: e.message === "busy" ? "You already have a few things waiting — give Pepe a moment." : "Something went wrong — nothing was sent." });
    }
  });

  app.get("/api/rooms/:slug/dj/act/:id", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const id = parseInt(req.params.id, 10) || 0;
    const a = (await getQuery("SELECT id, status, message, label FROM pepe_actions WHERE id = ? AND user_id = ? AND kind = 'dj'", [id, req.user.userId]))[0];
    if (!a) return res.status(404).json({ ok: false, error: "No such action." });
    const r = RESULTS.get(id);
    res.json({ ok: true, status: a.status, message: a.message || "", label: a.label, results: r ? r.results : null });
  });
}

/** For the homepage room panel: "now playing" for a bridged room id, or null. */
function nowPlaying(id) {
  const room = djRoom(id);
  if (!room || !S.state || !S.state.connected || !S.state.now) return null;
  const n = S.state.now;
  return { title: n.title, artist: n.artist, playing: n.playing, dj: S.state.dj.on };
}

module.exports = { register, ingest, djRoom, nowPlaying, VERBS, _S: S, _RESULTS: RESULTS, _WATCH: WATCH };
