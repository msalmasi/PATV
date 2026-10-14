// camviewers.js — 1.99yq: 👁 who opens your cam through the website, Pepe telling you so, and blocking someone from it.
//
// Every way a PATV account can see a Camfrog cam through the bridge goes through here:
//   live      livecam.js          (▶ Live in the pad's cam popover; noted when the video first reaches the viewer - the
//                                  MediaMTX read hook - so asking for a cam Pepe then couldn't open tells nobody)
//   snap      bridge-relay.js     (the popover's snapshot - noted when Pepe's frame arrives, for everyone shown it,
//                                  including a viewer riding on a frame someone else asked for)
//   clip      camclip.js          (🎬 Clip - noted when the recording is ready)
//
// 1. Who may see it - camRefusal(login, userId) is the ONE check every path asks (live, snapshot request + read + save,
//    AI reference, clip request + preview + save):
//      * the cam owner switched their cam off for the website (livecam_optout: /settings/privacy or !livecam off),
//      * they keep their activity private (stories.privateLogins; !bridge hide / !incognito never reach the page at all:
//        Pepe lists them as "someone", with no login to ask for),
//      * the owner blocked this viewer (cam_blocks) - answered with a neutral "isn't available" that doesn't say why.
//    A block also ends that viewer's live stream at once (livecam.dropViewerOf -> the MediaMTX reader is kicked).
// 2. Telling the owner - noteView() logs every view (cam_views, kept KEEP_MS) and queues a notice for Pepe, who PMs the
//    owner in the room their cam is in (camfrog-bot pepe_camviewers.py). Not spammy:
//      * a live open always tells them, but the same viewer re-opening the same cam within LIVE_GAP_MS is the same open;
//      * a snapshot / clip tells them at most once per viewer per RECENT_MS (a live notice counts);
//      * at most one PM per owner per OWNER_GAP_MS - everything that arrives meanwhile becomes ONE digest PM
//        (up to DIGEST_MAX names, then "+N more").
//    The notices ride Pepe's live-cam poll (POST /api/bridge/livecam: `cv: true` in, `cv_notify` out, `cv_ack` back in).
//    A Pepe that doesn't send `cv: true` (older) gets none (he still has his old room line).
// 3. !whowatching / the privacy card - watching(owner): who has the cam open live right now (livecam sessions) + who took
//    a snapshot / clip in the last RECENT_MS.
// 4. Blocks - one home, table cam_blocks (owner = the cam's Camfrog login, user_id = the PATV account): !blockviewer /
//    !unblockviewer in Camfrog (POST /api/bridge/camviewers, bot token; Pepe vouches for the owner's login) or the card in
//    /settings/privacy (the account's linked Camfrog name). Names: a PATV username first, else a linked Camfrog login.
//
// Routes:
//   POST /api/bridge/camviewers        Pepe: {op: block | unblock | list | watching, owner, target}
//   GET  /api/privacy/camviewers       the signed-in owner: {linked, login, blocks, live, recent}
//   POST /api/privacy/camviewers       {op: block | unblock, target} (JSON + X-Requested-With + same site)
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const guard = require("./middleware/authGuard");

const LOGIN_RE = /^[\w.\-$]{1,40}$/;
const NAME_RE = /^[\w.\-$]{1,40}$/;
const RECENT_MS = 30 * 60 * 1000;
const LIVE_GAP_MS = 2 * 60 * 1000;
const OWNER_GAP_MS = 60 * 1000;
const NOTE_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 20 * 1000;
const DIGEST_MAX = 6;
const KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_BLOCKS = 500;
const KINDS = new Set(["live", "snap", "clip"]);
const WEB_MARK = "\u{1f310}";

let clock = () => Date.now();
const now = () => clock();

const UNAVAILABLE = "That cam isn't available right now.";
const MSG = {
  opted_out: "They've switched their cam off for the website.",
  private: "They keep their activity private, so their cam isn't shown here.",
  unavailable: UNAVAILABLE,
};

let deps = {
  optedOut: (login) => { try { return require("./livecam").optedOut(login); } catch (e) { return false; } },
  privateLogins: (list) => require("./stories").privateLogins(list),
  dropViewer: (owner, userId, why) => { try { return require("./livecam").dropViewerOf(owner, userId, why); } catch (e) { return 0; } },
  liveWatchers: (owner) => { try { return require("./livecam").watchersOf(owner); } catch (e) { return []; } },
};

// ── state ──
let BLOCKS = new Map();      // owner login -> Map(userId -> {username, created, via})
const NOTED = new Map();     // "owner|userId" -> {at, kind}: the last notice about this viewer on this cam
const OUT = new Map();       // notice id -> {id, owner, room, items: Map(userId -> item), created, notBefore, sentAt, tries}
const PEND = new Map();      // owner -> id of the notice still collecting (not handed to Pepe yet)
const LASTPM = new Map();    // owner -> when a notice was last handed to Pepe

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS cam_blocks (owner TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, created INTEGER NOT NULL,
                      via TEXT, PRIMARY KEY (owner, user_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS cam_blocks_user ON cam_blocks (user_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS cam_views (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, room_id TEXT, user_id TEXT NOT NULL,
                      username TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS cam_views_owner ON cam_views (owner, at)");
      await loadBlocks();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function loadBlocks() {
  const m = new Map();
  for (const r of await getQuery("SELECT owner, user_id, username, created, via FROM cam_blocks")) {
    const o = String(r.owner).toLowerCase();
    if (!m.has(o)) m.set(o, new Map());
    m.get(o).set(String(r.user_id), { username: r.username || "", created: Number(r.created) || 0, via: r.via || "" });
  }
  BLOCKS = m;
}

const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
/** Has the owner of `login`'s cam blocked this PATV account? (sync; the table is mirrored in memory) */
function blocked(login, userId) {
  const m = BLOCKS.get(low(login));
  return !!(m && userId != null && m.has(String(userId)));
}

/**
 * May `userId` see `login`'s cam through the website (live, snapshot, clip)? null = yes, else {code, status, error}.
 * The one check every path asks. `userId` may be null (only the owner's own switches are checked then).
 */
async function camRefusal(login, userId) {
  const l = low(login);
  if (!LOGIN_RE.test(l)) return { code: "unavailable", status: 404, error: UNAVAILABLE };
  await init();
  if (deps.optedOut(l)) return { code: "opted_out", status: 403, error: MSG.opted_out };
  try { if ((await deps.privateLogins([l])).has(l)) return { code: "private", status: 403, error: MSG.private }; } catch (e) { /* none */ }
  if (userId != null && blocked(l, userId)) return { code: "unavailable", status: 403, error: UNAVAILABLE };
  return null;
}

// ── views + notices ──
function displayOf(u) {
  let d = "";
  try { d = require("./displaynames").usable(u && u.displayname) || ""; } catch (e) { d = ""; }
  d = String(d).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return d && low(d) !== low(u && u.username) ? d : "";
}
/**
 * A PATV account opened `owner`'s cam in `roomId` (kind live | snap | clip). Logs it and queues a notice for Pepe.
 * u = {userId, username, displayname?, camfrogUsername?}. Never throws; returns whether a notice was queued.
 */
function noteView(kind, roomId, owner, u, t = now()) {
  try {
    const o = low(owner);
    if (!KINDS.has(kind) || !LOGIN_RE.test(o) || !u || !u.userId) return false;
    const uid = String(u.userId);
    if (low(u.camfrogUsername) === o) return false;                    // their own cam
    init().then(() => runQuery("INSERT INTO cam_views (owner, room_id, user_id, username, kind, at) VALUES (?, ?, ?, ?, ?, ?)",
      [o, String(roomId || ""), uid, u.username || null, kind, t])).catch((e) => console.error("[camviewers] log:", e.message));
    const k = o + "|" + uid;
    const prev = NOTED.get(k);
    if (prev && (kind === "live" ? prev.kind === "live" && t - prev.at < LIVE_GAP_MS : t - prev.at < RECENT_MS)) return false;
    NOTED.set(k, { at: t, kind });
    let N = PEND.has(o) ? OUT.get(PEND.get(o)) : null;
    if (!N) {
      N = { id: "cv" + crypto.randomBytes(8).toString("hex"), owner: o, room: String(roomId || ""), items: new Map(), created: t,
            notBefore: Math.max(t, (LASTPM.get(o) || 0) + OWNER_GAP_MS), sentAt: 0, tries: 0 };
      OUT.set(N.id, N);
      PEND.set(o, N.id);
    }
    if (roomId) N.room = String(roomId);                                // the room the owner's cam was last seen in
    const it = N.items.get(uid) || { username: u.username || "", display: displayOf(u), camfrog: u.camfrogUsername ? String(u.camfrogUsername) : "",
                                     kinds: [], at: t };
    if (!it.kinds.includes(kind)) it.kinds.push(kind);
    it.at = t;
    N.items.set(uid, it);
    return true;
  } catch (e) {
    console.error("[camviewers] note:", e.message);
    return false;
  }
}
/** noteView for accounts known by id only (a snapshot's viewers when Pepe's frame arrives). Fire and forget. */
function noteViewers(kind, roomId, owner, userIds, t = now()) {
  const ids = (userIds || []).map(String).filter(Boolean).slice(0, 50);
  if (!ids.length) return Promise.resolve(0);
  return usersById(ids).then((U) => {
    let n = 0;
    for (const id of ids) { const u = U.get(id); if (u && noteView(kind, roomId, owner, u, t)) n++; }
    return n;
  }).catch((e) => { console.error("[camviewers] note:", e.message); return 0; });
}
/** The notices for Pepe's poll (and his acks of the last ones). body: {cv, cv_ack}. */
function forBot(body, t = now()) {
  body = body || {};
  for (const id of (Array.isArray(body.cv_ack) ? body.cv_ack : []).slice(0, 200)) {
    const N = OUT.get(String(id));
    if (N) { OUT.delete(N.id); if (PEND.get(N.owner) === N.id) PEND.delete(N.owner); }
  }
  const out = [];
  for (const N of [...OUT.values()]) {
    if (t - N.created > NOTE_TTL_MS) { OUT.delete(N.id); if (PEND.get(N.owner) === N.id) PEND.delete(N.owner); continue; }
    if (body.cv !== true) continue;
    const due = N.sentAt ? t - N.sentAt > RESEND_MS && N.tries < 3 : N.notBefore <= t;
    if (!due) continue;
    if (!N.sentAt) LASTPM.set(N.owner, t);
    N.sentAt = t;
    N.tries++;
    if (PEND.get(N.owner) === N.id) PEND.delete(N.owner);              // frozen: new views start the next notice
    const items = [...N.items.values()].sort((a, b) => (b.kinds.includes("live") - a.kinds.includes("live")) || b.at - a.at);
    out.push({ id: N.id, room: N.room, login: N.owner, viewers: items.slice(0, DIGEST_MAX).map((x) => ({ username: x.username, display: x.display,
      camfrog: x.camfrog, kinds: x.kinds.slice() })), more: Math.max(0, items.length - DIGEST_MAX) });
    if (out.length >= 50) break;
  }
  for (const [k, v] of NOTED) if (t - v.at > RECENT_MS) NOTED.delete(k);
  for (const [o, at] of LASTPM) if (t - at > OWNER_GAP_MS) LASTPM.delete(o);
  return out;
}
function prune(t = now()) {
  return runQuery("DELETE FROM cam_views WHERE at < ?", [t - KEEP_MS]).catch(() => {});
}

// ── who's watching ──
async function usersById(ids) {
  const list = [...new Set(ids.map(String))].slice(0, 200);
  if (!list.length) return new Map();
  const rows = await getQuery(`SELECT userId, username, displayname, camfrogUsername FROM users WHERE userId IN (${list.map(() => "?").join(",")})`, list);
  return new Map(rows.map((r) => [String(r.userId), r]));
}
const person = (u, uid) => (u ? { username: u.username || "", display: displayOf(u), camfrog: u.camfrogUsername ? String(u.camfrogUsername) : "" }
  : { username: "", display: "", camfrog: "", id: uid });
/** -> {live: [{username, display, camfrog, room, since}], recent: [{username, display, camfrog, kinds, at}]} */
async function watching(owner, t = now()) {
  await init();
  const o = low(owner);
  if (!LOGIN_RE.test(o)) return { live: [], recent: [] };
  const live = (deps.liveWatchers(o) || []).filter((x) => x && x.userId);
  const rows = await getQuery(`SELECT user_id, kind, MAX(at) AS at FROM cam_views WHERE owner = ? AND at > ? GROUP BY user_id, kind ORDER BY at DESC LIMIT 200`,
    [o, t - RECENT_MS]);
  const U = await usersById(live.map((x) => x.userId).concat(rows.map((r) => r.user_id)));
  const liveIds = new Set(live.map((x) => String(x.userId)));
  const rec = new Map();
  for (const r of rows) {
    const uid = String(r.user_id);
    if (liveIds.has(uid) && r.kind === "live") continue;
    const x = rec.get(uid) || { ...person(U.get(uid), uid), kinds: [], at: 0 };
    if (!x.kinds.includes(r.kind)) x.kinds.push(r.kind);
    x.at = Math.max(x.at, Number(r.at) || 0);
    rec.set(uid, x);
  }
  return {
    live: live.map((x) => ({ ...person(U.get(String(x.userId)), String(x.userId)), room: x.room || "", since: x.since || null })),
    recent: [...rec.values()].sort((a, b) => b.at - a.at).slice(0, 30),
  };
}

// ── blocks ──
async function hasArchived() {
  try { return (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at"); } catch (e) { return false; }
}
/** A viewer's name -> {userId, username, login} | {error}. A PATV username first, then a linked Camfrog login, "u:<id>". */
async function resolveViewer(raw) {
  let s = String(raw == null ? "" : raw).trim().replace(/^@/, "");
  if (s.startsWith(WEB_MARK)) s = s.slice(WEB_MARK.length).trim().replace(/^@/, "");
  if (!s) return { error: "Who? Give their PATV name." };
  if (/^u:/.test(s)) { try { return await require("./bridgeblocks").resolveTarget(s); } catch (e) { return { error: "No PATV account has that id." }; } }
  if (!NAME_RE.test(s)) return { error: "That isn't a name." };
  const l = low(s);
  const live = (await hasArchived()) ? "AND archived_at IS NULL" : "";
  const pick = (r) => (r ? { userId: String(r.userId), username: r.username, login: r.camfrogUsername || null } : null);
  const byName = (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE lower(username) = ? ${live} LIMIT 1`, [l]))[0];
  if (byName) return pick(byName);
  const byLogin = await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE lower(camfrogUsername) = ? ${live} LIMIT 2`, [l]);
  if (byLogin.length === 1) return pick(byLogin[0]);
  return { error: `No PATV account called ${s}.` };
}
const rowOut = (uid, b) => ({ userId: uid, username: b.username || "", created: b.created || 0, via: b.via || "" });
function listBlocks(owner) {
  const m = BLOCKS.get(low(owner));
  return m ? [...m.entries()].map(([uid, b]) => rowOut(uid, b)).sort((a, b) => b.created - a.created) : [];
}
/** owner blocks a viewer. -> {ok, user, already} | {ok:false, error} */
async function block(owner, target, { via = "web", byUserId = null, t = now() } = {}) {
  await init();
  const o = low(owner);
  if (!LOGIN_RE.test(o)) return { ok: false, error: "That isn't a Camfrog name." };
  const r = await resolveViewer(target);
  if (r.error) return { ok: false, error: r.error };
  if (low(r.login) === o || (byUserId && String(byUserId) === r.userId)) return { ok: false, error: "That's you." };
  const m = BLOCKS.get(o) || new Map();
  const already = m.has(r.userId);
  if (!already && m.size >= MAX_BLOCKS) return { ok: false, error: `You can block up to ${MAX_BLOCKS} people - unblock someone first.` };
  if (!already) {
    await tx(async () => {
      await runQuery(`INSERT INTO cam_blocks (owner, user_id, username, created, via) VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(owner, user_id) DO UPDATE SET username = excluded.username`, [o, r.userId, r.username || null, t, via === "chat" ? "chat" : "web"]);
    });
    m.set(r.userId, { username: r.username || "", created: t, via: via === "chat" ? "chat" : "web" });
    BLOCKS.set(o, m);
  }
  const dropped = deps.dropViewer(o, r.userId, "blocked") || 0;           // their live stream ends now (the reader is kicked)
  console.log(`[camviewers] block owner=${o} viewer=${r.username} via=${via}${dropped ? " (live ended)" : ""}`);
  return { ok: true, already, ended: dropped, user: { username: r.username || "", camfrog: r.login || "" } };
}
async function unblock(owner, target, { via = "web" } = {}) {
  await init();
  const o = low(owner);
  const m = BLOCKS.get(o);
  const s = low(String(target || "").replace(/^@/, "").replace(WEB_MARK, ""));
  if (!s) return { ok: false, error: "Who? Give their PATV name." };
  let uid = null;
  if (m) for (const [id, b] of m) if (low(b.username) === s || id === s.replace(/^u:/, "")) { uid = id; break; }
  if (!uid) {
    const r = await resolveViewer(target);
    if (r.error) return { ok: false, error: r.error };
    uid = r.userId;
  }
  if (!m || !m.has(uid)) return { ok: true, was: false };
  const b = m.get(uid);
  await runQuery("DELETE FROM cam_blocks WHERE owner = ? AND user_id = ?", [o, uid]);
  m.delete(uid);
  if (!m.size) BLOCKS.delete(o);
  console.log(`[camviewers] unblock owner=${o} viewer=${b.username} via=${via}`);
  return { ok: true, was: true, user: { username: b.username || "" } };
}
/** The signed-in account's linked Camfrog login, or null. */
async function loginOf(userId) {
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  const l = r && r.camfrogUsername ? low(r.camfrogUsername) : "";
  return LOGIN_RE.test(l) ? l : null;
}
/** Admin visibility (counts only; blocks are the owner's own). */
function stats() {
  let n = 0;
  for (const m of BLOCKS.values()) n += m.size;
  return { owners: BLOCKS.size, blocks: n, pending: OUT.size };
}

// ── routes ──
function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[camviewers] init:", e.message));
  const tm = setInterval(() => { prune(); }, 6 * 3600 * 1000);
  if (tm.unref) tm.unref();
  const fail = (res, e) => { console.error("[camviewers]", e); res.status(500).json({ ok: false, error: "Something went wrong." }); };

  app.post("/api/bridge/camviewers", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      const owner = low(b.owner);
      if (!LOGIN_RE.test(owner)) return res.status(400).json({ ok: false, error: "bad owner" });
      const op = String(b.op || "");
      if (op === "block") return res.json(await block(owner, b.target, { via: "chat" }));
      if (op === "unblock") return res.json(await unblock(owner, b.target, { via: "chat" }));
      if (op === "list") { await init(); return res.json({ ok: true, blocks: listBlocks(owner) }); }
      if (op === "watching") return res.json({ ok: true, ...(await watching(owner)), blocks: listBlocks(owner).length });
      res.status(400).json({ ok: false, error: "bad op" });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/privacy/camviewers", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      await init();
      const login = await loginOf(req.user.userId);
      if (!login) return res.json({ ok: true, linked: false });
      res.json({ ok: true, linked: true, login, blocks: listBlocks(login), ...(await watching(login)) });
    } catch (e) { fail(res, e); }
  });
  const hit = guard.limiter({ max: 30, windowMs: 60 * 60 * 1000 });
  app.post("/api/privacy/camviewers", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const login = await loginOf(req.user.userId);
      if (!login) return res.status(409).json({ ok: false, error: "Link your Camfrog name first - this is about your cam there." });
      const key = "u:" + req.user.userId;
      if (hit.blocked(key)) return res.status(429).json({ ok: false, error: "That's a lot of changes - try again in a while." });
      hit.hit(key);
      const b = req.body || {};
      const op = String(b.op || "");
      let r;
      if (op === "block") r = await block(login, b.target, { via: "web", byUserId: req.user.userId });
      else if (op === "unblock") r = await unblock(login, b.target, { via: "web" });
      else return res.status(400).json({ ok: false, error: "block or unblock?" });
      if (!r.ok) return res.status(400).json(r);
      res.json({ ...r, blocks: listBlocks(login) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, register, camRefusal, blocked, noteView, noteViewers, forBot, watching, block, unblock, listBlocks, resolveViewer, stats, prune,
  UNAVAILABLE, MSG, RECENT_MS, LIVE_GAP_MS, OWNER_GAP_MS, NOTE_TTL_MS, RESEND_MS, DIGEST_MAX,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setDeps: (d) => { deps = Object.assign({}, deps, d || {}); },
  _reset: () => { BLOCKS = new Map(); NOTED.clear(); OUT.clear(); PEND.clear(); LASTPM.clear(); ready = null; },
  _out: OUT,
};
