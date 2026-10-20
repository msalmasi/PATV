// stageleave.js — stagefix site (V1-2 of the dynamic-stages design, §14.2 + DF-45): "Take me off this Stage".
//
// The person whose Camfrog cam is on a pad's Stage - a 🎬 cam slot (mainstage.js source 'cam', put there by the pad's owner or
// staff) - takes themselves off. It acts at once (the slot ends, the stage lets go of the relay; their personal ▶ Live viewers
// are untouched - that's !livecam off) and that pad can't put their cam back on its Stage for 1 hour (LEAVE_MS); another
// "take me off" on the same pad within 24 h of the END of the last exclusion doubles it (2 h, 4 h ... up to 24 h, MAX_MS), and
// it stays at 24 h while they keep doing it (a pad that waits out the 24 h and puts them straight back gets 24 h again, not
// 1 h). They may also ask for longer straight away (hours: 1-24). Manual pins by the pad's owner and by site staff are
// refused alike (staff pins follow the subject's rules - DF-43); the refusal is livecam's neutral "That cam isn't available
// right now" and never says why.
// The mic stage (V1-1, micfollow.js) asks excludedUntil() too (train2 merge: its eligOf - the neutral CUT "unavailable", so
// it never re-picks them - and leave() steps that pad at once, micfollow.onStageLeave). Still open: stagepin.levelOf():
// "never" keeping a cam off the mic stage as well, and "off" meaning never automatic (a pin waits for their yes).
// The slot ends with the neutral "cam_unavailable" (by "system") - the same end reason as private activity or a block, so
// whoever put the cam up can't tell a take-off from the rest.
// Who asks: livecam.stageConsent (every put, and mainstage camBeat's re-hold after a restart), livecam.stageRecheck (every
// tick of an open cam slot), mainstage.camCandidates ("unavailable" in the owner's list) and - against a take-off that
// commits while a put is in flight - mainstage.camOpen's write itself (excludedInTx, read inside its transaction; leave()
// ends the open slots only after its own write, so one of the two always sees the other).
//
// Where:
//   * the pad's Stage: a cam slot showing the viewer's own Camfrog cam carries mine: true (mainstage.slotsFor) and the
//     page shows "Your cam is on this pad's Stage · Take me off this Stage" (public/js/stage-room.js)
//   * Settings → Privacy, the 🎬 card (public/js/privacy-stage.js): where your cam is on a Stage now, and the pads that
//     are keeping you off (until when)
//   * Camfrog: `!stage off me [hours]` - Pepe's existing !stage route (roomsweb.js POST /api/rooms/stage/act, verb "off",
//     arg "me"), open to everyone for that one verb. Pepe has to forward it for everyone (his !stage is owners / admins only),
//     with proven: true (stagefix fix: his identity check says the sender IS that login - a display name never counts), and
//     say so in his live-cam poll (stage_off_me: true, livecam.stageOffMeOk) before anything tells people to type it.
//
//   POST /api/stage/leave            {slot} | {room} (+ hours) - signed in, a linked Camfrog name, same-site fetch + JSON
//   GET  /api/privacy/stage          {linked, login, on: [{slot, pad, title, slug, since}], off: [{pad, title, slug, until}],
//                                     level, yes: [{pad, title, slug, at}], asks: [{id, kind, pad, title, slug, by, expires}]}
//
// Data (this module owns it): stage_leave (room_id, login) PK - login = the Camfrog login, lower case; user_id = the linked
// account when there is one; until (ms); n = how many in the current run (a run ends 24 h after the last exclusion ENDED); first_at,
// last_at; len = how long the last one was (ms; stagefix final round: a repeat doubles THAT, so someone who asked for 24 h and
// is put straight back gets 24 h again, not 2 h); via (web | chat). Rows are kept until 24 h after `until` (the doubling reads
// the last one), then pruned. In the account export (chat.stage_leave) and deleted with the account (accountdelete DELETE_ROWS);
// merged with it (user_id).
// The person's other say over pins - never / off (an ask) / the per-pad yes / the 10-minute "Keep going?" check - is
// stagepin.js; its card data rides GET /api/privacy/stage (mine()) and its routes are registered from here.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const guard = require("./middleware/authGuard");

const HOUR = 3600 * 1000;
const LEAVE_MS = HOUR;                  // the first time
const MAX_MS = 24 * HOUR;               // the longest a pad is kept away
const RUN_MS = 24 * HOUR;               // another one within this long of the last one's END doubles it
const LOGIN_RE = /^[\w.\-$]{1,40}$/;

let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
const key = (roomId, login) => String(roomId) + "|" + low(login);

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code || null; } }

// ── state: the exclusions still running, in memory (every check is synchronous) ──
let UNTIL = new Map();                  // "<room>|<login>" -> until (ms)
let GEN = 0;                            // bumped by every leave(): a load() that overlapped one reads again
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_leave (room_id TEXT NOT NULL, login TEXT NOT NULL, user_id TEXT, until INTEGER NOT NULL,
                      n INTEGER NOT NULL DEFAULT 1, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, via TEXT, PRIMARY KEY (room_id, login))`);
      await runQuery("CREATE INDEX IF NOT EXISTS stage_leave_login ON stage_leave (login)");
      const cols = await getQuery("PRAGMA table_info(stage_leave)");
      if (!cols.some((c) => c.name === "len")) await runQuery("ALTER TABLE stage_leave ADD COLUMN len INTEGER");   // stagefix final round
      await load();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function load(t = now()) {
  for (let i = 0; i < 3; i++) {
    const g = GEN;
    const m = new Map();
    for (const r of await getQuery("SELECT room_id, login, until FROM stage_leave WHERE until > ?", [t])) m.set(key(r.room_id, r.login), Number(r.until));
    // stagefix final round: a take-off that landed while this read ran set the OLD map - it would be lost from memory until the
    // next hourly load (the put's in-transaction check still refused it, but the owner's list and the tick read memory): read again
    if (g !== GEN && i < 2) continue;
    UNTIL = m;
    return;
  }
}
/** Is `login` keeping their cam off room `roomId`'s Stage right now? -> until (ms) | 0. Synchronous (memory). */
function excludedUntil(roomId, login, t = now()) {
  if (!roomId || !login) return 0;
  const u = UNTIL.get(key(roomId, login)) || 0;
  return u > t ? u : 0;
}
/** The same question off the table, for a caller inside a write (mainstage.camOpen's tx): a take-off that committed after the
 *  caller's first (memory) check is seen here. -> until (ms) | 0 */
async function excludedInTx(roomId, login, t = now()) {
  if (!roomId || !LOGIN_RE.test(low(login))) return 0;
  const r = (await getQuery("SELECT until FROM stage_leave WHERE room_id = ? AND login = ? AND until > ?", [String(roomId), low(login), t]))[0];
  return r ? Number(r.until) : 0;
}
/**
 * How long this one keeps them off: the hours they asked for, or - a repeat in the run - twice the LAST one's length (prevMs;
 * stagefix final round: it used to double by count, so a 24 h ask followed by a re-pin came back as 2 h), else 1 h doubling per
 * repeat; at least 1 h, at most 24 h.
 */
function lengthFor(n, hours, prevMs = 0) {
  const asked = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Math.min(24, Math.floor(Number(hours))) * HOUR : 0;
  const step = n > 1 && Number(prevMs) > 0 ? Number(prevMs) * 2 : LEAVE_MS * Math.pow(2, Math.max(0, Math.min(10, n - 1)));
  return Math.min(MAX_MS, Math.max(LEAVE_MS, asked, step));
}

/**
 * `login` takes their cam off room `roomId`'s Stage: the exclusion (one row, in a transaction) and then every open cam slot of
 * theirs on that pad ends. -> {ok, until, n, ended, at}
 */
async function leave({ roomId, login, userId = null, via = "web", hours = null } = {}, t = now()) {
  await init();
  const l = low(login), rid = String(roomId || "");
  if (!rid || !LOGIN_RE.test(l)) throw new Refuse(400, "Whose cam, on which pad?", "bad");
  const out = await tx(async () => {
    const r = (await getQuery("SELECT until, n, first_at, last_at, len FROM stage_leave WHERE room_id = ? AND login = ?", [rid, l]))[0];
    // stagefix fix: the run is measured from the END of the last exclusion (until), not from when it was asked for - a pad that
    // waits out a 24 h exclusion and puts them right back must not reset it to 1 h
    const inRun = !!r && t - Number(r.until || r.last_at || 0) < RUN_MS;
    const n = inRun ? Math.min(99, Number(r.n || 1) + 1) : 1;
    const running = r && Number(r.until) > t ? Number(r.until) : 0;
    // stagefix final round: the last one's own length (rows from before the column: until - last_at)
    const prev = inRun ? Number(r.len) || Math.max(0, Number(r.until) - Number(r.last_at)) : 0;
    const len = lengthFor(n, hours, prev);
    const until = Math.min(t + MAX_MS, Math.max(running, t + len));
    await runQuery(`INSERT INTO stage_leave (room_id, login, user_id, until, n, first_at, last_at, via, len) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(room_id, login) DO UPDATE SET user_id = COALESCE(excluded.user_id, stage_leave.user_id), until = excluded.until,
                    n = excluded.n, first_at = excluded.first_at, last_at = excluded.last_at, via = excluded.via, len = excluded.len`,
                   [rid, l, userId ? String(userId) : null, until, n, inRun ? Number(r.first_at) : t, t, via === "chat" ? "chat" : "web", until - t]);
    return { until, n };
  });
  GEN++;
  UNTIL.set(key(rid, l), out.until);
  // off the Stage now: every open cam slot of theirs on this pad (the slot's end lets go of the relay - livecam.stageRelease)
  let ended = 0;
  try {
    const S = require("./mainstage");
    for (const s of await S.openSlots(rid)) {
      if (s.source !== "cam" || low(s.cam_login) !== l) continue;
      // stagefix fix: the neutral end reason (the actor sees it on /stage and in the pad's log) - never "they took themselves off"
      if (await S.end(s.id, "cam_unavailable", "system")) ended++;
    }
  } catch (e) { console.error("[stageleave] end:", e.message); }
  // train2 merge: the pad's 🎙 mic stage too - a tile of theirs comes off now (micfollow's eligOf reads excludedUntil above)
  try { require("./micfollow").onStageLeave(rid, l); } catch (e) { /* no mic follows */ }
  console.log(`[stageleave] room=${rid} n=${out.n} until=${new Date(out.until).toISOString()} ended=${ended} via=${via}`);
  return { ok: true, until: out.until, n: out.n, ended, at: t };
}
function prune(t = now()) {
  return runQuery("DELETE FROM stage_leave WHERE until < ?", [t - RUN_MS]).catch((e) => console.error("[stageleave] prune:", e.message));
}

// ── the person's own view ──
async function loginOf(userId) {
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  const l = r && r.camfrogUsername ? low(r.camfrogUsername) : "";
  return LOGIN_RE.test(l) ? l : null;
}
function padInfo(roomId) {
  let R = null;
  try { R = require("./rooms").getCached(String(roomId)); } catch (e) { R = null; }
  let slug = String(roomId);
  try { if (R) slug = require("./pads").padSlug(R); } catch (e) { /* the id */ }
  return { pad: String(roomId), title: (R && R.title) || String(roomId), slug };
}
/** Settings → Privacy: where `userId`'s Camfrog cam is on a Stage now, and the pads keeping it off. */
async function mine(userId, t = now()) {
  await init();
  const login = await loginOf(userId);
  if (!login) return { linked: false, login: null, on: [], off: [] };
  let open = [];
  try { open = (await require("./mainstage").openSlots()).filter((s) => s.source === "cam" && low(s.cam_login) === login); } catch (e) { open = []; }
  const on = open.map((s) => ({ slot: s.id, ...padInfo(s.room_id), since: s.went_live || s.created || null, live: !!s.publishing }));
  const off = (await getQuery("SELECT room_id, until FROM stage_leave WHERE login = ? AND until > ? ORDER BY until DESC LIMIT 50", [login, t]))
    .map((r) => ({ ...padInfo(r.room_id), until: Number(r.until) }));
  // stagefix final round: their level, the pads they said yes to and the asks out to them now (stagepin.js)
  let pin = { level: "on", yes: [], asks: [] };
  try { pin = await require("./stagepin").mine(login, t); } catch (e) { console.error("[stageleave] stagepin:", e.message); }
  return { linked: true, login, on, off, ...pin };
}

// ── routes ──
function register(app, { addUser }) {
  init().catch((e) => console.error("[stageleave] init:", e.message));
  require("./stagepin").register(app, { addUser });     // stagefix final round: the level, the per-pad yes, the asks
  const tm = setInterval(() => { prune(); load().catch(() => {}); }, 3600 * 1000);
  if (tm.unref) tm.unref();
  const hits = guard.limiter({ max: 20, windowMs: 60 * 60 * 1000 });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
    console.error("[stageleave]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.get("/api/privacy/stage", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await mine(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/leave", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, code: "signin", error: "Sign in first." });
    try {
      const login = await loginOf(req.user.userId);
      if (!login) throw new Refuse(409, "Link your Camfrog name first - this is about your cam there.", "unlinked");
      const b = req.body || {};
      let roomId = null;
      if (b.slot) {
        const s = await require("./mainstage").getSlot(String(b.slot).slice(0, 64));
        // only a cam slot showing YOUR cam - anyone else's (or a stream) is "no such slot", whatever it is
        if (!s || s.source !== "cam" || low(s.cam_login) !== login) throw new Refuse(404, "That isn't your cam on a stage.", "gone");
        roomId = s.room_id;
      } else if (b.room) {
        const R = await require("./roomsweb").resolveRoom(String(b.room).slice(0, 128));
        if (!R) throw new Refuse(404, "No such pad.", "gone");
        roomId = R.id;
      } else throw new Refuse(400, "Which stage?", "bad");
      const k = "u:" + req.user.userId;
      const wait = hits.blocked(k);
      if (wait) { res.set("Retry-After", String(wait)); throw new Refuse(429, "That's a lot - try again later.", "rate"); }
      hits.hit(k);
      res.json(await leave({ roomId, login, userId: req.user.userId, via: "web", hours: b.hours }));
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, load, register, leave, excludedUntil, excludedInTx, lengthFor, mine, prune, Refuse, LEAVE_MS, MAX_MS, RUN_MS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { UNTIL = new Map(); ready = null; },
};
