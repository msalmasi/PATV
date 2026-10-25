// stagepin.js — stagefix site (D-17 (a) + DF-45 of the dynamic-stages design; the owner accepted both on 2026-10-19): the person
// whose Camfrog cam a pad's owner or staff put on the pad's Stage (a 🎬 cam slot, mainstage.js source 'cam') has a say over those
// MANUAL pins, not only a way off ("Take me off this Stage" is stageleave.js).
//
//   * Their LEVEL (Settings → Privacy, the 🎬 card - a linked Camfrog name; one row per Camfrog login):
//       on     (the default) a pad may put the cam up; "Take me off this Stage" and the 10-minute check below protect them
//       off    a pin waits for their yes on that pad: the owner's "Put on stage" becomes an ASK ("Mia's Pad wants to put your
//              cam on its Stage · Allow / No", inbox + Camfrog PM, answered on the card); the owner sees "waiting for their OK"
//              and the cam goes up by itself when they allow it (as whoever asked, if they still run the pad)
//       never  no pad's Stage at all - refused with the neutral "unavailable"; the ▶ Live button is unaffected
//     A new level acts at once: "never" ends every cam slot of theirs, "off" every one without their yes for that pad.
//   * The PER-PAD YES: "Allow" to an ask, or "Keep going, don't ask again on this pad" to the check. That pad then pins them in
//     one tap and skips the check. Listed on the card with "Remove" (revoking it on "off" ends the pin). Kept 180 days after
//     its last use (DF-24). A "No" keeps that pad from asking again for 6 h ("unavailable" meanwhile).
//   * The 10-MINUTE CHECK (DF-45): a cam slot that has been live 10 minutes without the person's per-pad yes asks them "Keep
//     going / Take me off" (inbox + PM, the card, Pepe's "!stage ok" / "!stage no"); no answer within 2 minutes ends it with
//     the neutral "cam_unavailable" - the same end reason as a take-off, a block or private activity, so whoever put them up
//     can't tell which. "Take me off" is stageleave.leave (1 h, doubling up to 24 h). "Keep going" holds for that slot.
//     An unlinked Camfrog cam is asked only once Pepe forwards "!stage ok" (his live-cam poll says stage_ok: true -
//     livecam.stageOkOk, a bot change); before that they have no way to answer, so no check runs for them and their ways off
//     stay "!livecam off" (and "!stage off me" once he forwards it).
//   Staff pins follow all of it (DF-43). mainstage.camOpen asks pinGate() before a put, mainstage.camBeat asks slotWhy() every
//   tick, mainstage.camCandidates shows "unavailable" / "waiting" / "ask" in the owner's list.
//
//   POST /api/privacy/stage/level   {level: on|off|never}          (linked; same-site fetch + JSON)
//   POST /api/privacy/stage/pad     {room, yes: false}             remove a per-pad yes
//   POST /api/stage/ask/:id         {answer: yes|no | keep|keep_always|off}
//   GET  /api/privacy/stage         (stageleave.js) carries mine(): {level, yes: [...], asks: [...]}
//   Pepe: POST /api/rooms/stage/act verb "ok" / "no" (roomsweb.js; proven: true) -> answerChat()
//
// Data (this module owns it):
//   stage_level      (login PK, user_id, level, updated, via) - "on" has no row
//   stage_pad_prefs  (room_id, login) PK, user_id, answer yes|no, at, used_at - pruned 180 days after used_at (a "no": 6 h)
//   stage_asks       (id PK, kind pin|check, room_id, login, user_id, slot_id, actor_id, actor_name, created, expires,
//                    status pending|yes|no|expired|cancelled ("never" voids the asks out), answered_at, via) - pruned after 30 days
// In the account export (chat.stage_level / stage_pad_prefs / stage_asks), deleted with the account, merged with it.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const guard = require("./middleware/authGuard");

const HOUR = 3600 * 1000;
const LEVELS = ["on", "off", "never"];
const ASK_MS = 10 * 60 * 1000;          // a pin waiting for the person's yes
const CHECK_AFTER_MS = 10 * 60 * 1000;  // continuous manual airtime before "Keep going / Take me off"
const CHECK_MS = 2 * 60 * 1000;         // ...and how long they have to answer
const NO_MS = 6 * HOUR;                 // after "No", that pad can't ask again for this long
const PREF_TTL_MS = 180 * 24 * HOUR;    // a per-pad yes, after its last use (DF-24)
const ASK_KEEP_MS = 30 * 24 * HOUR;
const LOGIN_RE = /^[\w.\-$]{1,40}$/;
const STAGING = !!process.env.STAGING;

let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
const key = (roomId, login) => String(roomId) + "|" + low(login);
const MS = () => require("./mainstage");
const LC = () => require("./livecam");

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code || null; } }

// ── state: levels and per-pad answers in memory (the owner's list and every tick read them synchronously) ──
let LEVEL = new Map();                  // login -> "off" | "never"
let PREF = new Map();                   // "<room>|<login>" -> {answer, at}
let GEN = 0;                            // bumped by every write: a load() that overlapped one reads again
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_level (login TEXT PRIMARY KEY, user_id TEXT, level TEXT NOT NULL, updated INTEGER NOT NULL, via TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_pad_prefs (room_id TEXT NOT NULL, login TEXT NOT NULL, user_id TEXT, answer TEXT NOT NULL,
                      at INTEGER NOT NULL, used_at INTEGER, PRIMARY KEY (room_id, login))`);
      await runQuery("CREATE INDEX IF NOT EXISTS stage_pad_prefs_login ON stage_pad_prefs (login)");
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_asks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, room_id TEXT NOT NULL, login TEXT NOT NULL,
                      user_id TEXT, slot_id TEXT, actor_id TEXT, actor_name TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL,
                      status TEXT NOT NULL, answered_at INTEGER, via TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS stage_asks_login ON stage_asks (login, status)");
      await runQuery("CREATE INDEX IF NOT EXISTS stage_asks_slot ON stage_asks (slot_id)");
      await load();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function load() {
  for (let i = 0; i < 3; i++) {
    const g = GEN;
    const lv = await getQuery("SELECT login, level FROM stage_level");
    const pf = await getQuery("SELECT room_id, login, answer, at FROM stage_pad_prefs");
    if (g !== GEN && i < 2) continue;             // a write landed while we read: read again (it'd be lost from memory)
    LEVEL = new Map(lv.filter((r) => r.level === "off" || r.level === "never").map((r) => [low(r.login), r.level]));
    PREF = new Map(pf.filter((r) => r.answer === "yes" || r.answer === "no").map((r) => [key(r.room_id, r.login), { answer: r.answer, at: Number(r.at) }]));
    return;
  }
}

/** `login`'s level: "on" (default) | "off" | "never". Synchronous (memory). */
function levelOf(login) { return LEVEL.get(low(login)) || "on"; }
/** Has `login` said yes to room `roomId`'s Stage (per pad)? Synchronous. */
function padYes(roomId, login) { const p = PREF.get(key(roomId, login)); return !!(p && p.answer === "yes"); }
/** Until when (ms) room `roomId` may not ask `login` again after their "No" (0 = it may). Synchronous. */
function noUntil(roomId, login, t = now()) {
  const p = PREF.get(key(roomId, login));
  return p && p.answer === "no" && p.at + NO_MS > t ? p.at + NO_MS : 0;
}
async function linkedId(login) {
  try { const r = (await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ? LIMIT 1", [low(login)]))[0]; return r ? String(r.userId) : null; }
  catch (e) { return null; }
}
/** The per-pad answer, on disk (inside the caller's transaction); notePref() puts it in memory once that committed. */
async function writePref(roomId, login, answer, userId, t = now()) {
  await runQuery(`INSERT INTO stage_pad_prefs (room_id, login, user_id, answer, at, used_at) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(room_id, login) DO UPDATE SET user_id = COALESCE(excluded.user_id, stage_pad_prefs.user_id), answer = excluded.answer,
                  at = excluded.at, used_at = excluded.used_at`, [String(roomId), low(login), userId || null, answer, t, t]);
}
function notePref(roomId, login, answer, t = now()) {
  GEN++;
  PREF.set(key(roomId, login), { answer, at: t });
}
const lastTouch = new Map();
function touch(roomId, login, t = now()) {               // a per-pad yes in use: its 180 days start again (written at most hourly)
  const k = key(roomId, login);
  if ((lastTouch.get(k) || 0) > t - HOUR) return;
  lastTouch.set(k, t);
  if (lastTouch.size > 5000) lastTouch.clear();
  runQuery("UPDATE stage_pad_prefs SET used_at = ? WHERE room_id = ? AND login = ?", [t, String(roomId), low(login)]).catch(() => {});
}

function padInfo(roomId) {
  let R = null;
  try { R = require("./rooms").getCached(String(roomId)); } catch (e) { R = null; }
  let slug = String(roomId);
  try { if (R) slug = require("./pads").padSlug(R); } catch (e) { /* the id */ }
  return { pad: String(roomId), title: (R && R.title) || String(roomId), slug };
}
const site = () => process.env.SITE_URL || (STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv");
const stageOkOk = () => { try { return LC().stageOkOk(); } catch (e) { return false; } };

// ── asks ──
async function pending(roomId, login, kind, t = now()) {
  return (await getQuery("SELECT * FROM stage_asks WHERE room_id = ? AND login = ? AND kind = ? AND status = 'pending' AND expires > ? ORDER BY created DESC LIMIT 1",
                         [String(roomId), low(login), kind, t]))[0] || null;
}
/** Who may ask `login` at all: their linked account (inbox + PM, the card), or - unlinked - Pepe forwarding "!stage ok". */
async function reach(login) {
  const uid = await linkedId(login);
  return { userId: uid, ok: !!uid || stageOkOk() };
}
async function tell(a, { userId, title, body, actorId }) {
  try {
    if (userId) {
      await require("./rooms").notify(userId, { kind: "stage", title, body, link: "/settings/privacy#stage", ref: "stage-ask:" + a.id });
      return;
    }
    // unlinked (only once Pepe forwards !stage ok): a PM via Pepe, queued as whoever put them up
    if (actorId) {
      await require("./actions").queue(actorId, { kind: "notify", args: [a.login, (title + " - " + body).slice(0, 300), "stage"], tag: "stage-notify", label: title });
    }
  } catch (e) { console.error("[stagepin] tell:", e.message); }
}
const chatHint = () => (stageOkOk() ? " Or say !stage ok / !stage no in Camfrog." : "");
async function newAsk(o, t = now()) {
  const a = { id: crypto.randomBytes(9).toString("base64url"), kind: o.kind, room_id: String(o.roomId), login: low(o.login), user_id: o.userId || null,
              slot_id: o.slotId || null, actor_id: o.actorId ? String(o.actorId) : null, actor_name: o.actorName ? String(o.actorName).slice(0, 60) : null,
              created: t, expires: t + o.ms, status: "pending" };
  await runQuery(`INSERT INTO stage_asks (id, kind, room_id, login, user_id, slot_id, actor_id, actor_name, created, expires, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                 [a.id, a.kind, a.room_id, a.login, a.user_id, a.slot_id, a.actor_id, a.actor_name, a.created, a.expires]);
  return a;
}

/**
 * Before a manual pin (mainstage.camOpen): -> null (put it up now) | "never" | "declined" (they said No to this pad < 6 h ago) -
 * both refused as "unavailable" | "waiting" (an ask is out) | "ask" (level off, no yes for this pad: ask instead).
 */
async function pinGate(roomId, login, t = now()) {
  await init();
  const lv = levelOf(login);
  if (lv === "never") return "never";
  if (lv !== "off" || padYes(roomId, login)) { if (padYes(roomId, login)) touch(roomId, login, t); return null; }
  if (noUntil(roomId, login, t)) return "declined";
  return (await pending(roomId, login, "pin", t)) ? "waiting" : "ask";
}
/** Level off: ask `login` whether room `roomId` may put their cam up (`actor` asked). -> the ask | null (they can't be asked)
 *  mfix: target "mic" = a 📌 pin on the pad's mic stage (micfollow.pinPut) - noted as slot_id "mic", so an Allow pins it there. */
const MIC_TARGET = "mic";
async function askPin({ roomId, login, actor, display, target = null }, t = now()) {
  await init();
  const r = await reach(login);
  if (!r.userId) return null;                   // "off" is set on the website: no linked account left = nobody to ask
  const a = await newAsk({ kind: "pin", roomId, login, userId: r.userId, actorId: actor && actor.userId, actorName: actor && (actor.username || actor.userId), ms: ASK_MS,
                           slotId: target === MIC_TARGET ? MIC_TARGET : null }, t);
  const P = padInfo(roomId);
  await tell(a, { userId: r.userId, title: `${P.title} wants to put your cam on its Stage on PATV`,
                  body: `Allow or No within ${Math.round(ASK_MS / 60000)} minutes in Settings → Privacy - nothing goes up without your OK.` + chatHint() });
  console.log(`[stagepin] ask pin room=${roomId} ask=${a.id}`);
  return a;
}

/**
 * Every tick of an open cam slot (mainstage.camBeat): -> null | "unavailable" (end it). The level ("never"; "off" without a yes
 * for this pad or a "Keep going" for this slot) and the 10-minute check: ask once the slot has been live CHECK_AFTER_MS without
 * the person's per-pad yes; an answer of "Take me off" or none within CHECK_MS ends it.
 */
async function slotWhy(s, t = now()) {
  await init();
  if (!s || s.source !== "cam") return null;
  const login = low(s.cam_login), rid = String(s.room_id || "");
  if (!LOGIN_RE.test(login) || !rid) return null;
  const lv = levelOf(login);
  if (lv === "never") return "unavailable";
  if (padYes(rid, login)) { touch(rid, login, t); return null; }
  const a = (await getQuery("SELECT * FROM stage_asks WHERE slot_id = ? AND kind = 'check' ORDER BY created DESC LIMIT 1", [String(s.id)]))[0] || null;
  if (a && a.status === "yes") return null;                      // "Keep going" - for this slot
  if (lv === "off") return "unavailable";                        // a pin waits for their yes (taken back, or the level changed)
  if (a && a.status === "pending") {
    if (Number(a.expires) > t) return null;
    await runQuery("UPDATE stage_asks SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'pending'", [t, a.id]);
    console.log(`[stagepin] check unanswered room=${rid} slot=${s.id}`);
    return "unavailable";
  }
  if (a) return "unavailable";                                   // "Take me off" (stageleave already ended it) / expired
  const since = Number(s.went_live || 0);
  if (!since || t - since < CHECK_AFTER_MS) return null;
  const r = await reach(login);
  if (!r.ok) return null;                                        // unlinked and Pepe can't forward an answer: nobody to ask
  const n = await newAsk({ kind: "check", roomId: rid, login, userId: r.userId, slotId: s.id, actorId: s.userId, actorName: s.username, ms: CHECK_MS }, t);
  const P = padInfo(rid);
  await tell(n, { userId: r.userId, actorId: s.userId, title: `${P.title} has had your cam on its Stage for ${Math.round(CHECK_AFTER_MS / 60000)} minutes - keep going?`,
                  body: `Keep going or Take me off within ${Math.round(CHECK_MS / 60000)} minutes, or it comes off by itself.` +
                        (r.userId ? " Answer in Settings → Privacy." + chatHint() : " Say !stage ok to stay on, !stage no to come off.") +
                        (r.userId ? "" : " " + site() + "/p/" + encodeURIComponent(P.slug)) });
  console.log(`[stagepin] ask check room=${rid} slot=${s.id} ask=${n.id}`);
  return null;
}
/** stagefix: re-check `login`'s open cam slots now (a new level, a removed yes) - ends the ones slotWhy refuses. -> count */
async function recheckOpen(login, roomId = null, t = now()) {
  let n = 0;
  try {
    for (const s of await MS().openSlots(roomId || undefined)) {
      if (s.source !== "cam" || low(s.cam_login) !== low(login)) continue;
      if ((await slotWhy(s, t)) && (await MS().end(s.id, "cam_unavailable", "system"))) n++;
    }
  } catch (e) { console.error("[stagepin] recheck:", e.message); }
  return n;
}

/**
 * The person answers an ask. who: {userId} (the website) or {login, proven: true} (Pepe). answer: pin -> yes | no;
 * check -> keep | keep_always | off. -> {ok, kind, status, put?, until?}
 */
async function answer(id, ans, who = {}, via = "web", t = now()) {
  await init();
  const a = (await getQuery("SELECT * FROM stage_asks WHERE id = ?", [String(id || "").slice(0, 40)]))[0];
  if (!a) throw new Refuse(404, "That ask doesn't exist.", "gone");
  let may = !!(who.login && who.proven === true && low(who.login) === a.login);
  if (!may && who.userId) {
    const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(who.userId)]))[0];
    may = !!(u && u.camfrogUsername && low(u.camfrogUsername) === a.login);
  }
  if (!may) throw new Refuse(404, "That ask doesn't exist.", "gone");      // someone else's: the same as none
  const ok = a.kind === "pin" ? ["yes", "no"] : ["keep", "keep_always", "off"];
  if (!ok.includes(ans)) throw new Refuse(400, a.kind === "pin" ? "Allow or No?" : "Keep going or Take me off?", "bad");
  if (a.status !== "pending") throw new Refuse(409, "That's already answered.", "answered");
  if (Number(a.expires) <= t) {
    await runQuery("UPDATE stage_asks SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'pending'", [t, a.id]);
    throw new Refuse(409, "That ask has expired.", "expired");
  }
  const status = ans === "no" || ans === "off" ? "no" : "yes";
  const pref = a.kind === "pin" || ans === "keep_always" ? status : null;      // the per-pad answer it leaves (a check's "keep" doesn't)
  const won = await tx(async () => {
    const r = await runQuery("UPDATE stage_asks SET status = ?, answered_at = ?, via = ? WHERE id = ? AND status = 'pending'", [status, t, via === "chat" ? "chat" : "web", a.id]);
    if (!r.changes) return false;
    if (pref) await writePref(a.room_id, a.login, pref, a.user_id || who.userId || null, t);
    return true;
  });
  if (!won) throw new Refuse(409, "That's already answered.", "answered");
  if (pref) notePref(a.room_id, a.login, pref, t);
  console.log(`[stagepin] answer room=${a.room_id} ask=${a.id} kind=${a.kind} ${ans} via=${via}`);
  const out = { ok: true, kind: a.kind, status, pad: padInfo(a.room_id) };
  if (a.kind === "check" && ans === "off") {
    const r = await require("./stageleave").leave({ roomId: a.room_id, login: a.login, userId: a.user_id || null, via: via === "chat" ? "chat" : "web" }, t);
    out.until = r.until;
  }
  if (a.kind === "pin" && status === "yes") {
    // the pin they allowed goes up now, as whoever asked - if that person still runs the pad (owner or staff)
    out.put = false;
    try {
      const actor = a.actor_id ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [a.actor_id]))[0] : null;
      if (actor && (await require("./rooms").canManage(actor, a.room_id))) {
        // mfix: an ask for a 📌 pin on the mic stage pins it there (micfollow.pinPut - the mic stage's own rules on top)
        const r = a.slot_id === MIC_TARGET ? await require("./micfollow").pinPut(actor, a.room_id, a.login, t, { fromAsk: true })
          : await MS().camOpen(actor, { room: a.room_id, login: a.login });
        out.put = !!(r && (r.slot || r.pinned));
      }
    } catch (e) { out.put = false; out.put_error = e && e.refuse ? e.message : null; if (!(e && e.refuse)) console.error("[stagepin] put:", e.message); }
  }
  return out;
}
/** Pepe: "!stage ok" / "!stage no" from `login` (proven) - the newest ask out to them (in `roomId` first, when it's a pad). */
async function answerChat(login, verb, roomId = null, t = now()) {
  await init();
  const l = low(login);
  const rows = await getQuery("SELECT * FROM stage_asks WHERE login = ? AND status = 'pending' AND expires > ? ORDER BY created DESC LIMIT 10", [l, t]);
  const a = (roomId && rows.find((x) => x.room_id === String(roomId))) || rows[0];
  if (!a) return { ok: false, message: "nobody is asking about your cam right now" };
  const ans = a.kind === "pin" ? (verb === "ok" ? "yes" : "no") : (verb === "ok" ? "keep" : "off");
  const r = await answer(a.id, ans, { login: l, proven: true }, "chat", t);
  const P = r.pad;
  if (a.kind === "check") {
    if (ans === "keep") return { ok: true, message: `OK - you stay on ${P.title}'s stage` };
    const hrs = Math.max(1, Math.round((r.until - t) / HOUR));
    return { ok: true, message: `you're off ${P.title}'s stage on PATV - it can't put your cam back for ${hrs} hour${hrs === 1 ? "" : "s"}` };
  }
  return { ok: true, message: ans === "yes" ? `OK - ${P.title} can put your cam on its stage` + (r.put ? " (it's up now)" : "") : `OK - your cam stays off ${P.title}'s stage` };
}

// ── the person's settings ──
async function setLevel(login, level, { userId = null, via = "web" } = {}, t = now()) {
  await init();
  const l = low(login);
  if (!LOGIN_RE.test(l)) throw new Refuse(400, "Whose cam?", "bad");
  if (!LEVELS.includes(level)) throw new Refuse(400, "On, off or never?", "bad");
  if (level === "on") await runQuery("DELETE FROM stage_level WHERE login = ?", [l]);
  else {
    await runQuery(`INSERT INTO stage_level (login, user_id, level, updated, via) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(login) DO UPDATE SET user_id = COALESCE(excluded.user_id, stage_level.user_id), level = excluded.level,
                    updated = excluded.updated, via = excluded.via`, [l, userId || null, level, t, via === "chat" ? "chat" : "web"]);
  }
  GEN++;
  if (level === "on") LEVEL.delete(l); else LEVEL.set(l, level);
  // "never": the asks out to them now are void (an "Allow" can't put them up any more)
  if (level === "never") await runQuery("UPDATE stage_asks SET status = 'cancelled', answered_at = ? WHERE login = ? AND status = 'pending'", [t, l]);
  // "never" ends every pin now, "off" every one without their yes for that pad (the more recent choice)
  const ended = level === "on" ? 0 : await recheckOpen(l, null, t);
  console.log(`[stagepin] level ${level} ended=${ended} via=${via}`);
  return { ok: true, level, ended };
}
async function dropYes(roomId, login, t = now()) {
  await init();
  const r = await runQuery("DELETE FROM stage_pad_prefs WHERE room_id = ? AND login = ? AND answer = 'yes'", [String(roomId), low(login)]);
  GEN++;
  const p = PREF.get(key(roomId, login));
  if (p && p.answer === "yes") PREF.delete(key(roomId, login));
  const ended = r.changes ? await recheckOpen(login, roomId, t) : 0;
  return { ok: true, removed: r.changes > 0, ended };
}
/** The 🎬 card (stageleave.mine adds it): the level, the pads they said yes to, the asks out to them now. */
async function mine(login, t = now()) {
  await init();
  const l = low(login);
  const yes = (await getQuery("SELECT room_id, at FROM stage_pad_prefs WHERE login = ? AND answer = 'yes' ORDER BY at DESC LIMIT 50", [l]))
    .map((r) => ({ ...padInfo(r.room_id), at: Number(r.at) }));
  const asks = (await getQuery("SELECT * FROM stage_asks WHERE login = ? AND status = 'pending' AND expires > ? ORDER BY created DESC LIMIT 10", [l, t]))
    .map((a) => ({ id: a.id, kind: a.kind, ...padInfo(a.room_id), by: a.actor_name || null, expires: Number(a.expires) }));
  return { level: levelOf(l), yes, asks };
}
/** The owner's list (mainstage.camCandidates): the pin asks out on room `roomId` now. -> Set(login) */
async function waitingIn(roomId, t = now()) {
  await init();
  return new Set((await getQuery("SELECT login FROM stage_asks WHERE room_id = ? AND kind = 'pin' AND status = 'pending' AND expires > ?", [String(roomId), t]))
    .map((r) => low(r.login)));
}
function prune(t = now()) {
  return Promise.all([
    runQuery("DELETE FROM stage_pad_prefs WHERE (answer = 'yes' AND COALESCE(used_at, at) < ?) OR (answer = 'no' AND at < ?)", [t - PREF_TTL_MS, t - NO_MS]),
    runQuery("DELETE FROM stage_asks WHERE created < ?", [t - ASK_KEEP_MS]),
  ]).then(() => load()).catch((e) => console.error("[stagepin] prune:", e.message));
}

// ── routes ──
async function loginOf(userId) {
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  const l = r && r.camfrogUsername ? low(r.camfrogUsername) : "";
  return LOGIN_RE.test(l) ? l : null;
}
function register(app, { addUser }) {
  init().catch((e) => console.error("[stagepin] init:", e.message));
  const tm = setInterval(() => { prune(); }, 6 * HOUR);
  if (tm.unref) tm.unref();
  const hits = guard.limiter({ max: 60, windowMs: 60 * 60 * 1000 });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
    console.error("[stagepin]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  // same-site fetch + JSON, signed in, a linked Camfrog name; rate-limited
  const pre = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return null; }
    if (!req.is("application/json")) { res.status(415).json({ ok: false, error: "JSON only." }); return null; }
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, code: "signin", error: "Sign in first." }); return null; }
    const k = "u:" + req.user.userId;
    const wait = hits.blocked(k);
    if (wait) { res.set("Retry-After", String(wait)); res.status(429).json({ ok: false, code: "rate", error: "That's a lot - try again later." }); return null; }
    hits.hit(k);
    const login = await loginOf(req.user.userId);
    if (!login) { res.status(409).json({ ok: false, code: "unlinked", error: "Link your Camfrog name first - this is about your cam there." }); return null; }
    return login;
  };
  app.post("/api/privacy/stage/level", addUser, async (req, res) => {
    try {
      const login = await pre(req, res);
      if (!login) return;
      res.json(await setLevel(login, String((req.body || {}).level || ""), { userId: req.user.userId, via: "web" }));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/privacy/stage/pad", addUser, async (req, res) => {
    try {
      const login = await pre(req, res);
      if (!login) return;
      const b = req.body || {};
      if (b.yes !== false) throw new Refuse(400, "A pad's yes can only be removed here.", "bad");
      res.json(await dropYes(String(b.room || "").slice(0, 128), login));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/ask/:id", addUser, async (req, res) => {
    try {
      const login = await pre(req, res);
      if (!login) return;
      res.json(await answer(req.params.id, String((req.body || {}).answer || ""), { userId: req.user.userId }, "web"));
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, load, register, levelOf, padYes, noUntil, pinGate, askPin, slotWhy, recheckOpen, answer, answerChat, setLevel, dropYes, mine, waitingIn, prune,
  Refuse, LEVELS, ASK_MS, CHECK_AFTER_MS, CHECK_MS, NO_MS, PREF_TTL_MS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { LEVEL = new Map(); PREF = new Map(); ready = null; },
};
