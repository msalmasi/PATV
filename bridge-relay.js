// bridge-relay.js — the two-way part of the room bridge (STAGING TEST, bot 1.99).
//
// Signed-in website users can, where a room admin has switched it on in Camfrog:
//   * say   a chat line, relayed by Pepe as "🌐 <camfrog name> (web): …" in a different font
//           (needs a linked Camfrog name; !bridge relay on)
//   * clip  a short push-to-talk recording that Pepe plays on the mic (linked name; !bridge mic on)
//   * snap  a still of an on-cam user's cam, opened by Pepe (any signed-in user; !bridge cams on)
//
// Jobs live in memory only and reach Pepe in the response to his own /api/bridge/sync POST (no
// extra polling); he acks in the next sync. Clip audio is handed over once (/api/bridge/clip) and
// dropped; cam frames are kept in memory for SNAP_TTL and never written anywhere. Each request is
// logged (account, kind, target — never the text, audio or image) for abuse tracing; Pepe also logs
// every relay to his mod log. Pepe re-checks every rule (moderation state, rate limits, switches).
//
// Save snap (1.99ap): the snapshot popover can turn the frame it shows into a real !snap. The browser
// only names the frame (its in-memory sid); the site checks that this account asked for that
// snapshot and that it hasn't expired, copies the frame aside (FRAME_TTL, memory only) and queues a
// website action ("snap.save", actions.js) that Pepe runs as the viewer's linked Camfrog name: the
// same !snap rules, price, routing, /feed post and expiry as in chat. Pepe fetches the frame by id
// (/api/bridge/snapframe, bot token, checked against the account) - image bytes are never accepted
// from a browser. Pepe says with each snapshot whether the !snap rules let THIS viewer save it (on /
// admins-only / opted out); Save and Download only show when they do.
//
// A PATV account with NO chat login (1.99wv, connections audit C): a chat line is relayed as the ACCOUNT - Pepe posts it as
// "🌐 <PATV username> (PATV web): ..." (camfrog-bot 1.99wt pepe_relay._relay_say_account): the username (unique on PATV),
// never a free-text display name, and a label a chat login's relay never gets, so nobody passes for a Camfrog user. Only
// while a Pepe that acts for accounts is running (actorcap.js), and only for an account that (accountRefusal):
//   * has proven an identity (verified.js: a verified email, Discord, Twitch, Telegram, Google, Apple or Plex - the anti-throwaway rule)
//   * isn't archived, casino-restricted, banned from the whole feed or from THIS pad's feed (the pad owner's ban)
//   * whose username isn't another account's linked chat login (no "🌐 alice" next to the real alice)
//   * says nothing the short-text guard catches (textguard.js: slurs, threats, doxxing, PAT scams, fake staff)
// Pepe adds the room's ignore lists, time-outs and his own rate limit. 1.99xa: what it says is NORMAL chat for the account
// (Pepe logs and remembers it under "u:<userId>" unless the account switched incognito on in Settings -> Privacy). Clips, cam
// snapshots / saves and typed "!" commands stay chat-login only; a 🐸 Pepe menu action runs as the account (padpepe.js).
//
// Blocks (1.99xa, bridgeblocks.js): a room's mods / the pad's owner / Pepe's admins can block an account's web relay into a room
// (or every room: admins) - its say / clip / "!" lines are refused here with the reason, and Pepe refuses them too (his mirror).
//
// Chat commands (1.99): a relay line starting with "!" is a COMMAND, not chat. It is queued as a
// "cmd" job carrying the account's verified Camfrog link (users.camfrogUsername - never anything
// from the request), and Pepe runs it in that room as that login through his real dispatcher: the
// same permissions, automod, cooldowns and PAT prices as typing it in Camfrog. Pepe sends each
// room's allowed commands + prices with the room snapshot (R.cmds, {} = off); the site refuses
// anything not on it plus its own deny-list copy, rate-limits per account, and requires JSON +
// X-Requested-With (no cross-site form can send that). Pepe echoes the line in the room as
// "🌐 <name> (web): !cmd ..."; replies he would have PM'd come back in the ack and show only in
// that user's own relay feed. Every command is written to bridge_cmd_log (account, Camfrog login,
// room, command, result) - admins read it at /api/bridge/cmdlog. "!commands" is answered here.
//
// 1.99ye: the web chat feels native.
//   * the page shows a line the moment it's typed ("sending…"), then "✓ sent" when Pepe has put it into the room (his
//     ack, sent the moment the packet is out), and swaps it for the room's own line when that comes back (the echo names
//     the job: `data.web.job`). A refusal comes back with a reason and a `code` (blocked, rate, queue_full, too_long,
//     offline, gated, relay_off, account, nopepe, unconfirmed, ...).
//   * a say carries the page's client id (`cid`): the same cid again returns the job it already made, so a retry after a
//     lost answer can't post twice. A say job is offered to Pepe ONCE (like a command): a lost ack is reported as
//     "unconfirmed" after SAY_CLAIM_TTL instead of risking a double post.
//   * several lines in a row: up to SAY_QUEUE_MAX waiting per member per room (and SAY_MINUTE_MAX a minute); they go to
//     Pepe in order and HE paces them for the room (pepe_relay's say lane) - nothing is refused for being quick.
//   * push, not polling: Pepe long-polls POST /api/bridge/relay/pull (answered the moment a job is queued) and posts acks
//     to /api/bridge/relay/ack straight away; the page long-polls /live?wait=1 (bridge.js). The old paths (jobs + acks
//     riding Pepe's sync, the page polling every 1.5 s) still work - an older Pepe / page just uses them.
const express = require("express");
const crypto = require("crypto");
const { getQuery, runQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const queueAction = (...a) => require("./actions").queue(...a);   // lazy: actions.js opens its table on load
const CV = () => require("./camviewers");                         // 1.99yq: opt-out / private / the owner's blocks + "X opened your cam"
// 1.99yh: cam snapshots / clips / live cams follow the pad's access rule like the room audio (padaccess.full: signed in,
// and inside an Approved pad). The /api/rooms/:slug gate (padaccess.register) covers Approved pads already; this is the
// route's own check, so a snapshot never depends on middleware order or on how the slug resolved. Fails closed.
async function padFull(userId, roomId) {
  if (!userId || !roomId) return false;
  try { return !!(await require("./padaccess").fullFor(String(userId), roomId)); } catch (e) { return false; }
}
const PAD_DENIED = { ok: false, code: "pad_access", error: "This pad's live room is for its approved members." };

const SAY_MAX = 300, CLIP_MAX_BYTES = 600 * 1024, CLIP_MAX_SECS = 30;
const JOB_TTL = 3 * 60 * 1000, CLAIM_RETRY = 45 * 1000;
// A clip can wait minutes for the room's mic (Pepe 1.99bk waits up to 4 min in a busy room), so an
// unfinished clip job is kept CLIP_TTL; any finished job JOB_TTL after it finished.
const CLIP_TTL = 8 * 60 * 1000;
// Pepe's progress acks for a clip (1.99bk): state "queued" | "waiting" | "playing" keep the job open;
// an ack without one is final ("done"). Acks can arrive in one batch or out of order - never step back.
const PROGRESS = { queued: 1, waiting: 2, playing: 3 };
const stateRank = (s) => (s === "done" ? 9 : PROGRESS[s] || 0);
const SNAP_TTL = 2 * 60 * 1000, SNAP_TARGET_GAP = 20 * 1000, SNAP_VIEWER_GAP = 10 * 1000;
const FRAME_TTL = 5 * 60 * 1000;                                   // a queued save waits this long for Pepe
const SAVE_GAP = 20 * 1000, SAVE_BURST = 3, SAVE_WINDOW = 10 * 60 * 1000;  // = Pepe's own limit (pepe_relay.py)

const jobs = new Map();          // id -> {id, kind, roomId, userId, username, camfrog, text, data, mime, secs, target, state, at, claimed, tries, result}
const snaps = new Map();         // `${roomId}|${login}` -> {sid, ts, ok, status, img: Buffer, viewers: Set(userId), rule, okFor: Map(userId -> price), cost, saves: Map(userId -> action id)}
// micfollow: the 🎙 mic stage's stills, kept APART from viewers' snapshots: only frames of quiet mf jobs (Pepe opened the
// cam by its EXACT name) - never a viewer's own snapshot (his usual, fuzzy targeting) - and never offered as a viewer's frame
const mfSnaps = new Map();       // `${roomId}|${login}` -> {ts, ok, img: Buffer}
const isMfSnap = (j) => !!(j && j.kind === "snap" && j.mf === true);
// mic-stage snap job ids, kept past the job's own sweep: a late answer to one is still known as the mic stage's (never
// stored as a viewer's snapshot); true = cancelled (the person was cut / the tile left: the frame is dropped)
const mfIds = new Map();         // job id -> cancelled (bool)
// ... and WHEN each was cancelled: Pepe gets the recent ones as `mf_cancel` (his live-cam poll and the relay pull) - a job he
// had already claimed when a site-only cut landed (the mic-stage switch, an exclusion, cam access, private activity, a ban)
// is dropped by him before he opens the cam, or before he sends its frame
const mfCancelAt = new Map();    // job id -> when it was cancelled
const MF_CANCEL_KEEP_MS = 2 * 60 * 1000;
const frames = new Map();        // frame id -> {img, userId, username, roomId, login, ts}   (frames queued for a save)
const hits = new Map();          // `${kind}|${userId}` -> [timestamps]

// -- 1.99ye: the native-feeling web chat (see the top) --
const SAY_QUEUE_MAX = 5;                 // say lines waiting to go out, per member per room
const SAY_MINUTE_MAX = 20;               // say lines a minute per member (a sanity cap - Pepe paces the room itself)
const SAY_PENDING_TTL = 20 * 1000;       // never picked up by Pepe this long -> failed (it never left the site)
// 1.99yg: a Pepe that doesn't long-poll (an older one, or !bridge fast off) takes jobs only with his sync, which in a quiet
// room comes with the 30 s snapshot - give those lines this long instead
const SAY_PENDING_TTL_SYNC = 45 * 1000;
const SAY_CLAIM_TTL = 60 * 1000;         // picked up but never confirmed this long -> failed "unconfirmed"
const PULL_WAIT_MAX = 10 * 1000;         // Pepe's long-poll (staging's router gives a POST 15 s)
const CID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const CODE_RE = /^[a-z_]{2,24}$/;
const cids = new Map();                  // `${userId}|${cid}` -> job id (idempotent say)
const pullers = [];                      // Pepe's waiting long-polls: () => void
let notifyFn = null;                     // (roomId, userId) => void - bridge.js wakes the room's page long-polls
let lastPull = 0, drainHooked = false, draining = false;
const LAT = [];                          // the last LAT_KEEP say lines' timings (ms after the site took them)
const LAT_KEEP = 200;

// -- chat commands from the relay (1.99) --
const CMD_GAP = 2000, CMD_BURST = 10, CMD_WINDOW = 60 * 1000;      // = Pepe's own per-login limit
const CMD_MAX_REPLIES = 12;
// Never from the web (Pepe has the same list and is the one that decides; this is a second net).
const CMD_DENY = new Set(("!update !reload !reloadbot !vm !wheelfix !test !sniff !pktsniff !roomshell !clickbtn !clickbutton " +
  "!audiobtn !roombtns !roombuttons !roomtabs !roomwindows !menuwatch !listdiag !dumprows !memory !model !automod !perm " +
  "!perms !role !roles !botadmin !botadmins !redlist !admin !mod !moderator !friend !unrole !demote !removerole !ignore " +
  "!transcript !globalunblock !mute !unmute !roomaudio !bridge !chatty !chattycam !chattydepth !autotopic !lookmode " +
  "!lookpublic !greeter !greet !persona !personas !convo !campause !camresume !costume !costumes !dressup !votemodmode " +
  "!msg !message !patvmsg !dm !dms !inbox !verify !patv !patvname !incognito !forgetme !alias !log !history !modlog !search !userlist " +
  "!unames !analytics !activity !mystats !watchlist !cam !cams !opencam !camwatch !whowatching !activeroom !audioroom " +
  "!microom !joinroom !leaveroom !switchroom !roomswitch !winroom !wintrace !winlist !stream !scene !scenes !schedule " +
  "!sched !schedules !rec !record !autoclip !alerts !alert !web !epstein").split(" "));
const CMD_NAME_RE = /^![a-z0-9_-]{1,24}$/;
const cmdName = (t) => String(t || "").trim().split(/\s+/)[0].toLowerCase();

/** Pepe's per-room menu {"!topic": 1000, ...} -> a clean copy ({} when absent / off). */
function cleanCmds(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    const c = String(k).toLowerCase();
    if (!CMD_NAME_RE.test(c) || CMD_DENY.has(c)) continue;
    out[c] = Math.max(0, Math.min(1e9, parseInt(v, 10) || 0));
    if (++n >= 300) break;
  }
  return out;
}

/** "!commands" - answered by the site, from the room's menu. */
function commandsText(cmds) {
  const list = Object.keys(cmds || {}).sort();
  if (!list.length) return "Commands from the website aren't on in this Camfrog room.";
  const paid = list.filter((c) => cmds[c] > 0).map((c) => `${c} (${cmds[c].toLocaleString("en-US")} PAT)`);
  return `You can run ${list.length} commands here as your Camfrog name - same permissions and prices as in the room: ` +
    list.join(" ") + (paid.length ? `. Paid: ${paid.join(", ")} (admins free).` : ".");
}

const cmdLogReady = runQuery(`CREATE TABLE IF NOT EXISTS bridge_cmd_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT NOT NULL, username TEXT, camfrog TEXT,
  room TEXT, command TEXT, job TEXT, status TEXT, result TEXT, updated INTEGER)`).catch(() => {});
async function cmdLog(fields) {
  try {
    await cmdLogReady;
    await runQuery(`INSERT INTO bridge_cmd_log (ts, user_id, username, camfrog, room, command, job, status, result, updated)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Date.now(), fields.userId, fields.username || null, fields.camfrog || null, fields.room || null,
       String(fields.command || "").slice(0, 300), fields.job || null, fields.status, String(fields.result || "").slice(0, 300), Date.now()]);
  } catch (e) { console.error("[bridge-relay] cmd log:", e.message); }
}
function cmdLogResult(jobId, status, result) {
  cmdLogReady.then(() => runQuery("UPDATE bridge_cmd_log SET status = ?, result = ?, updated = ? WHERE job = ?",
    [status, String(result || "").slice(0, 300), Date.now(), jobId])).catch(() => {});
}

function limited(key, gap, burst, windowMs) {
  const now = Date.now();
  const q = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (q.length && now - q[q.length - 1] < gap) return `slow down — one every ${Math.round(gap / 1000)}s`;
  if (q.length >= burst) return `slow down — ${burst} per ${Math.round(windowMs / 60000)} min`;
  q.push(now);
  hits.set(key, q);
  return null;
}

function sweep(now) {
  for (const j of jobs.values()) {
    // 1.99ye: a say that Pepe never picked up never left the site - say so (the page offers Retry); one he picked up but
    // never confirmed may or may not be in the room (it is never re-offered, so a retry is the member's call)
    if (j.kind !== "say" || j.state === "done") continue;
    const pendTtl = now - lastPull < 60 * 1000 ? SAY_PENDING_TTL : SAY_PENDING_TTL_SYNC;
    if (j.state === "pending" && now - j.at > pendTtl) failJob(j, "nopepe", "Pepe isn't picking up messages right now — try again in a moment");
    else if (j.state === "claimed" && now - j.claimed > SAY_CLAIM_TTL) failJob(j, "unconfirmed", "Pepe didn't confirm it — it may not have reached the room");
  }
  for (const [id, j] of jobs) {
    const open = j.state !== "done";
    // 1.99ez: a cam clip (camclip.js) records for up to 30 s after Pepe gets to it - kept like a mic clip
    if (open ? now - j.at > (j.kind === "clip" || j.kind === "camclip" ? CLIP_TTL : JOB_TTL) : now - (j.doneAt || j.at) > JOB_TTL) jobs.delete(id);
  }
  for (const [k, s] of snaps) if (now - s.ts > SNAP_TTL) snaps.delete(k);
  for (const [k, s] of mfSnaps) if (now - s.ts > SNAP_TTL) mfSnaps.delete(k);
  for (const [k, f] of frames) if (now - f.ts > FRAME_TTL) frames.delete(k);
  for (const [k, q] of hits) if (!q.length || now - q[q.length - 1] > 15 * 60 * 1000) hits.delete(k);
  for (const [k, id] of cids) if (!jobs.has(id)) cids.delete(k);
}
setInterval(() => sweep(Date.now()), 5 * 1000).unref();      // 1.99ye: 5 s (was 15) - a say's timeout shows promptly

/** 1.99ye: tell bridge.js a job changed (its room's waiting page long-polls wake; the owner's `mine` moved on). */
function notify(j) {
  if (!notifyFn || !j) return;
  try { notifyFn(j.roomId, j.userId || null); } catch (e) { /* a page wake can't break the relay */ }
}
function setNotify(fn) { notifyFn = typeof fn === "function" ? fn : null; }
function failJob(j, code, msg) {
  j.state = "done"; j.doneAt = Date.now();
  j.result = { ok: false, msg: clean(msg, 200), code };
  j.data = null;
  notify(j);
}
function wakePullers() {
  for (const f of pullers.splice(0)) { try { f(); } catch (e) { /* gone */ } }
}
function hookDrain() {
  if (drainHooked) return;
  drainHooked = true;
  try { require("./shutdown").onDrain(() => { draining = true; wakePullers(); }); } catch (e) { /* no graceful stop here */ }
}
/** 1.99ye: one say line's timings, kept for the staging latency report and logged. */
function noteLatency(j) {
  if (j.kind !== "say" || j.latDone) return;
  j.latDone = true;
  const d = (t) => (t ? t - j.at : null);
  const s = { at: j.at, claim: d(j.claimed), ack: d(j.ackAt), echo: d(j.echoAt), via: j.via || "sync", pepe: j.pepeT || null };
  LAT.push(s);
  if (LAT.length > LAT_KEEP) LAT.splice(0, LAT.length - LAT_KEEP);
  console.log(`[bridge-relay] say-lat job=${j.id} via=${s.via} claim=${s.claim}ms ack=${s.ack}ms echo=${s.echo}ms` +
              (s.pepe ? ` pepe-wait=${s.pepe.wait}ms pepe-send=${s.pepe.send}ms` : ""));
}
function latency() { return LAT.slice(); }

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
  .replace(/<[^<>]{0,60}>/g, "").replace(/\s+/g, " ").trim().slice(0, n);

// Pepe's replies are shown with textContent, so a "<new room topic>" in a usage line stays as typed
// (clean() would eat it as markup); control / bidi characters still go.
const cleanReply = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
  .replace(/\s+/g, " ").trim().slice(0, 400);

/** 1.99ea: the name a web line goes into the room under - the account's PATV display name, or "" to let
 *  Pepe pick (the Camfrog display name, then the login). A display name is display only, so one that is
 *  ANOTHER account's login / username (or Pepe's) is never sent - "🌐 <someone else> (web)" can't happen.
 *  1.99eb: refused when it is another account's linked login (what the bridge resolves) OR another account's
 *  PATV username. 1.99en: lookup() is linked-only everywhere now, so both are checked explicitly (one query,
 *  userlinks.resolve) - at least as strict as before: a username match on another account refuses even
 *  when the login match is this account. */
async function webName(u) {
  let d = "";
  try { d = clean(require("./displaynames").usable(u && u.displayname), 40); } catch (e) { d = ""; }
  if (!d || /^pepe\s*(frog)?$/i.test(d)) return "";
  try {
    const UL = require("./userlinks");
    const k = UL.keyOf(d);
    if (k) {
      const found = await UL.resolve({ logins: [d], usernames: [k] });
      const me = String(u.username || "").toLowerCase();
      const other = (acc) => !!acc && String(acc.username).toLowerCase() !== me;
      if (other(found.logins.get(k)) || other(found.usernames.get(k))) return "";
    }
  } catch (e) { return ""; }
  return d;
}

/**
 * 1.99wv (connections audit C): why a PATV account with NO chat login can't relay `text` into pad room R, or null.
 * -> {status, error} | null. See the top of the file for what each rule protects against.
 */
async function accountRefusal(u, R, text) {
  const link = "link a chat account first (Settings → Account → Connections; for Camfrog, type !verify in a room with Pepe)";
  if (!require("./actorcap").on()) return { status: 403, error: "To talk in the chat room from here, " + link + "." };
  const FS = require("./feedstore");
  const A = await FS.account(u.userId).catch(() => null);
  if (!A || A.archived_at) return { status: 403, error: "This account can't talk here." };
  const V = require("./verified");
  if (!(await V.verify(A))) return { status: 403, error: "To talk in a pad's chat room with your PATV account, " + V.LINK_HINT + "." };
  if (A.casino_banned) return { status: 403, error: "Your account is restricted." };
  const t = Date.now();
  const bans = await getQuery("SELECT room_id FROM feed_bans WHERE user_id = ? AND (room_id = '' OR room_id = ?) AND (until IS NULL OR until > ?)",
    [u.userId, R.id, t]).catch(() => []);
  if (bans.length) return { status: 403, error: "You can't talk in this pad." };
  if (!(await require("./accountkey").ownsName(u.username, u.userId))) {
    return { status: 403, error: "Your PATV username is another member's chat name, so it can't be used here - " + link + "." };
  }
  if (require("./textguard").bad(text)) return { status: 400, error: "Pepe won't relay that." };
  return null;
}

/** 1.99xa: why a room mod's / an admin's !bridge block refuses this account's relay into room R (bridgeblocks.js), or null.
 *  1.99zf: per bridge feature (chat / commands / soundboard / voice / snapshots / livecams / clips; an "all" block covers each). */
async function blockedWhy(R, u, feature = "chat") {
  try { return await require("./bridgeblocks").refusal(R.id, u.userId, feature); } catch (e) { return null; }
}

function newJob(fields) {
  const j = Object.assign({ id: "w" + crypto.randomBytes(8).toString("hex"), state: "pending", at: Date.now(), claimed: 0, tries: 0, result: null }, fields);
  jobs.set(j.id, j);
  wakePullers();                 // 1.99ye: Pepe's waiting long-poll gets it now
  notify(j);
  return j;
}

/** The jobs to hand Pepe with this sync response (pending, or claimed but never acked).
 *  `via` (1.99ye): "pull" = Pepe's long-poll, else his sync - kept on say jobs for the latency report. */
function takeJobs(liveRoomIds, via = "sync") {
  const now = Date.now(), out = [];
  for (const j of jobs.values()) {
    if (!liveRoomIds.has(j.roomId)) continue;
    // A command is offered ONCE: a re-offer after a lost ack (or a Pepe restart, which forgets the job
    // ids it has seen) could run a paid command twice. Chat lines / clips / snaps may be retried.
    // 1.99ez: a cam clip is offered once too - a re-offer must never start a second recording of the same cam
    // 1.99fp: a mic clip preview too (once is enough - the browser asks again)
    // 1.99il: a tip announcement too (a re-offer could say it twice)
    // 1.99kp: a stream-start announcement too (golive.js); 1.99lr: a 📼 queue's "now playing" too; 1.99nk: a boost too
    // 1.99ye: a say too - it carries a client id now, and "unconfirmed" (SAY_CLAIM_TTL) is safer than a double post
    const due = j.state === "pending" || (j.kind !== "say" && j.kind !== "cmd" && j.kind !== "camclip" && j.kind !== "micclip" && j.kind !== "tipnote" && j.kind !== "golive" && j.kind !== "nowplaying" && j.kind !== "boostnote" && j.state === "claimed" && now - j.claimed > CLAIM_RETRY && j.tries < 2);
    if (!due) continue;
    // micfollow: a mic-stage still is offered only while the mic stage still wants it (Pepe knows nothing of the mic-stage
    // switch, the pad's exclusions, stage bans, private activity or cam access - the site checks them here, last thing)
    if (isMfSnap(j) && !mfStillWanted(j)) { cancelJob(j); continue; }
    j.state = "claimed"; j.claimed = now; j.tries++;
    if (j.kind === "say") j.via = via;
    notify(j);
    const base = { id: j.id, kind: j.kind, room: j.roomId, user: j.username, camfrog: j.camfrog || "" };
    if (j.kind === "say" && j.cid) base.cid = j.cid;          // 1.99ye: the page's client id (Pepe logs it with the line)
    // 1.99wv (connections audit C): the ACCOUNT behind every job - Pepe acts as `camfrog` when there is one, else as the account
    if (j.userId) { base.user_id = j.userId; base.actor = j.actor || { userId: j.userId, username: j.username || null, login: j.camfrog || null, display: null }; }
    if (j.kind === "say" || j.kind === "cmd") base.text = j.text;
    // 1.99co: a pad Manage-panel action (padmod.js) - the site-built line plus what Pepe re-checks / logs
    if (j.kind === "cmd" && j.gui) { base.gui = j.gui; if (j.reason) base.reason = j.reason; }
    if (j.kind === "cmd" && j.setting) base.setting = j.setting;
    if (j.kind === "cmd" && j.pepe) base.pepe = j.pepe;   // 1.99qr: a 🐸 Pepe menu action (padpepe.js) - Pepe re-checks line + cam
    if (j.kind === "modinfo") base.target = j.target || "";
    if (j.kind === "clip") { base.mime = j.mime; base.secs = j.secs; base.size = j.data ? j.data.length : 0; }
    // 1.99ea: the PATV display name for "🌐 <name> (web)" (Pepe falls back to the Camfrog display name, then the login)
    if ((j.kind === "say" || j.kind === "clip") && j.display) base.display = j.display;
    if (j.kind === "snap") { base.target = j.target; base.viewer = j.username; if (j.mf) base.mf = true; }   // micfollow: a quiet mic-stage still (no viewer)
    if (j.kind === "camclip") { base.target = j.target; base.viewer = j.username; base.secs = j.secs; }
    // 1.99aaf: 👻 staff in ghost mode - Pepe keeps them out of the room's mod log (the site audits it: cam_views ghost = 1)
    if ((j.kind === "snap" || j.kind === "camclip") && j.ghost) base.ghost = true;
    if (j.kind === "micclip") { base.target = j.target; base.viewer = j.username; base.tx = j.tx; }   // 1.99fp: 🔊 Clip on a 🎙 line
    // 1.99il: 💸 a tip made from this pad's page - Pepe says it in the room (target = the recipient's login)
    if (j.kind === "tipnote") { base.target = j.target; base.amount = j.amount; if (j.display) base.display = j.display; }
    if (j.kind === "golive" || j.kind === "nowplaying") { base.streamer = j.streamer; base.pad = j.pad; base.what = j.what || ""; base.link = j.link || ""; }   // 1.99kp / 1.99lr
    // 1.99nk: 🚀 a website boost of this pad (bridge.boostAnnounce) - Pepe coalesces them per room
    if (j.kind === "boostnote") { base.amount = j.amount; base.pad = j.pad; base.link = j.link || ""; if (j.display) base.display = j.display; }
    out.push(base);
    if (out.length >= 10) break;
  }
  return out;
}

function applyAcks(acks) {
  for (const a of Array.isArray(acks) ? acks.slice(0, 100) : []) {
    const j = a && jobs.get(String(a.id || ""));
    if (!j) continue;
    const replies = (Array.isArray(a.replies) ? a.replies : []).slice(0, CMD_MAX_REPLIES).map(cleanReply).filter(Boolean);
    if (a.late) {
      // a reply that came after the command finished (Pepe answered from a thread / timer)
      if (j.result) j.result.replies = (j.result.replies || []).concat(replies).slice(-CMD_MAX_REPLIES);
      continue;
    }
    const st = j.kind === "clip" && PROGRESS[a.state] ? a.state : "done";
    if (stateRank(st) < stateRank(j.state)) continue;          // an older step arriving late
    // 1.99ye: a say already settled by its echo (or failed by a timeout) keeps that answer
    if (j.kind === "say" && j.state === "done" && j.result) {
      if (!j.ackAt) j.ackAt = Date.now();
      // 1.99acb: an older Pepe reports the line to the bridge before the packet goes out - a send failure after its echo means
      // the room line shown here never reached Camfrog. Rare (never seen on prod); logged so a report can be checked.
      if (j.echoC && !a.ok && a.code === "send_failed") console.log(`[bridge-relay] say job=${j.id} acked send_failed AFTER its echo (c=${j.echoC}) - the line shown may not be in the room`);
      continue;
    }
    j.state = st;
    j.result = { ok: !!a.ok, msg: clean(a.msg, 200) };
    if (typeof a.code === "string" && CODE_RE.test(a.code)) j.result.code = a.code;
    if (st === "done") j.doneAt = Date.now();
    if (j.kind === "say") {
      j.ackAt = Date.now();
      // Pepe's own clock: how long the line waited in his say lane (pacing) and in his send queue
      const t = a.t && typeof a.t === "object" ? a.t : null;
      const ms = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(600000, Math.round(Number(v)))) : null);
      if (t) j.pepeT = { wait: ms(t.wait), send: ms(t.send) };
    }
    notify(j);
    if (j.kind === "cmd") {
      j.result.replies = replies;
      cmdLogResult(j.id, a.ok ? "ok" : "refused", j.result.msg);
      // 1.99pg: a Manage-panel room-role change goes in the pad's event log (settings hub audit list) with Pepe's answer
      if (typeof j.gui === "string" && j.gui.startsWith("role_")) {
        const detail = `${j.text} (as ${j.camfrog || "?"}) -> ${a.ok ? "done" : "refused"}: ${replies[0] || j.result.msg || ""}`;
        try { require("./rooms").event(j.roomId, "pad-role", j.username || null, detail); } catch (e) { /* no registry */ }
      }
    }
    if (j.kind === "modinfo") j.result.info = require("./padmod").cleanInfo(a.info);
    j.data = null;
  }
}

/** 1.99ye: the room's own line for say job `jobId` arrived (feed cursor `c`) - the page swaps its pending line for it.
 *  1.99acb: `roomId` = the room the line came from - a line in ANOTHER room never settles the job (the sender's page would
 *  drop its pending line for a row that isn't in its chat; logged). An echo proves the line reached the room, so it settles a
 *  timed-out say (unconfirmed / nopepe) as sent - but never one Pepe himself acked as never sent (send_failed). */
function noteEcho(jobId, c, roomId = null) {
  const j = jobs.get(String(jobId || ""));
  if (!j || j.kind !== "say" || j.echoC) return false;
  if (roomId && j.roomId !== roomId) {
    console.log(`[bridge-relay] echo of say job=${j.id} came from room ${roomId}, not the job's room ${j.roomId} - not swapped in`);
    return false;
  }
  if (j.result && !j.result.ok && j.result.code === "send_failed") return false;
  j.echoC = c; j.echoAt = Date.now();
  if (j.state !== "done" || !j.result || !j.result.ok) { j.state = "done"; j.doneAt = j.echoAt; j.result = { ok: true, msg: "sent" }; }
  noteLatency(j);
  notify(j);
  return true;
}

/** 1.99acb: the say job a room line names (its data.web.job) while this site still holds it, for attributing the line BY THE
 *  JOB (bridge.js feedItem) - who sent it (their account, linked login, PATV display name) and whether Pepe acked it as never
 *  sent. null = not a say job here (expired, another process) or a line from another room than the job's. */
function echoJob(jobId, roomId = null) {
  const j = jobs.get(String(jobId || ""));
  if (!j || j.kind !== "say" || (roomId && j.roomId !== roomId)) return null;
  return { id: j.id, userId: j.userId || "", username: j.username || "", camfrog: j.camfrog || "", display: j.display || "",
           sendFailed: !!(j.result && !j.result.ok && j.result.code === "send_failed") };
}

/** This user's recent relay jobs in a room (for the composer's status line). 1.99ye: a say carries its client id
 *  (`cid`), `c` = the feed cursor of its own room line once that came back, and `code` = why it failed. */
function mineFor(userId, roomId) {
  const out = [];
  for (const j of jobs.values()) {
    if (j.userId !== userId || j.roomId !== roomId || j.kind === "snap" || j.kind === "camclip" || j.kind === "modinfo" || j.kind === "tipnote" || j.kind === "golive" || j.kind === "nowplaying" || j.kind === "boostnote" || j.gui || j.setting || j.pepe) continue;   // panel jobs: padmod.js / padpepe.js
    const o = { id: j.id, kind: j.kind, state: j.state, ok: j.result ? j.result.ok : null, msg: j.result ? j.result.msg : "", at: j.at };
    if (j.kind === "cmd") { o.text = j.text; o.replies = (j.result && j.result.replies) || []; }
    if (j.kind === "say") {
      if (j.cid) o.cid = j.cid;
      if (j.echoC) o.c = j.echoC;
      if (j.result && j.result.code) o.code = j.result.code;
    }
    out.push(o);
  }
  return out.slice(-12);
}

/**
 * stkfix B3: why a relay line's stickers refuse it -> {status, body} | null. `raw` = the line as typed, `out` = as it goes out
 * (stickers.fallbackText). Stickers only from packs this account owns, at most 12 - the rule for DMs, posts and comments
 * (stickers.validate) - and the line with its stickers written out must still fit SAY_MAX: "[sticker: Who's talking?]" is
 * longer than "[sticker:miclife/who]", and Pepe cuts a longer line short without a word (1.99ye: too long is refused, never
 * cut short silently). A failed check (the database busy) is a 503 (the composer retries it), never a thrown error.
 */
async function stickerRefusal(u, raw, out) {
  try { await require("./stickers").validate(u.userId, raw); } catch (e) {
    if (e && e.refuse) return { status: e.status || 403, body: { ok: false, code: "sticker", error: e.message } };
    console.error("[bridge-relay] sticker check:", e && e.message);
    return { status: 503, body: { ok: false, code: "busy", error: "Couldn't check your stickers just now — try again in a moment." } };
  }
  if (String(out).length > SAY_MAX) {
    return { status: 400, body: { ok: false, code: "too_long", max: SAY_MAX,
             error: `That's too long once its stickers are written out for Camfrog ("[sticker: Name]") — ${SAY_MAX} characters at most.` } };
  }
  return null;
}

/** 1.99ye: one say line from member `u` (a users row: userId, username, displayname, camfrogUsername) into live room R.
 *  The /say route and the staging test route both come here. -> {status, body}. `cid` = the page's client id: the same
 *  one again answers with the job it already made (never a second post). */
async function sayLine(u, R, text, cid, opts = {}) {
  cid = CID_RE.test(String(cid || "")) ? String(cid) : "";
  const key = cid ? u.userId + "|" + cid : "";
  if (key && cids.has(key) && jobs.has(cids.get(key))) {
    const j = jobs.get(cids.get(key));
    return { status: 200, body: { ok: true, id: j.id, cid, dup: true, state: j.state } };
  }
  if (!text) return { status: 400, body: { ok: false, code: "empty", error: "Type something first." } };
  const blk = await blockedWhy(R, u, "chat");             // 1.99xa: !bridge block (bridgeblocks.js)
  if (blk) return { status: 403, body: { ok: false, code: "blocked", error: blk, blocked: true, feature: "chat" } };
  // stkfix B2: Camfrog can't show PATV art - the line goes out with "[sticker: Happy Pepe]" for each sticker, never the raw
  // token. That expanded line is what Pepe says, so the text filter (accountRefusal) and the length limit judge IT.
  const out = require("./stickers").fallbackText(text);
  if (!u.camfrogUsername) {
    const why = await accountRefusal(u, R, out);           // 1.99wv: a PATV account with no chat login (see the top)
    if (why) return { status: why.status, body: { ok: false, code: "account", error: why.error } };
  }
  const st = await stickerRefusal(u, text, out);           // stkfix B3: packs this account owns; the expanded length
  if (st) return st;
  text = out;
  let open = 0;
  for (const j of jobs.values()) if (j.kind === "say" && j.userId === u.userId && j.roomId === R.id && j.state !== "done") open++;
  if (open >= SAY_QUEUE_MAX) {
    return { status: 429, body: { ok: false, code: "queue_full", max: SAY_QUEUE_MAX, error: `You have ${SAY_QUEUE_MAX} messages waiting to go out — give them a second.` } };
  }
  const lim = limited("say|" + u.userId, 0, SAY_MINUTE_MAX, 60000);
  if (lim) return { status: 429, body: { ok: false, code: "rate", error: lim } };
  const display = u.camfrogUsername ? await webName(u) : "";
  const j = newJob({ kind: "say", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername || "", display, text,
                     actor: require("./actorcap").actorOf(u, display), cid: cid || null });
  if (key) cids.set(key, j.id);
  console.log(`[bridge-relay] say room=${R.id} account=${u.username} camfrog=${u.camfrogUsername || "-"} job=${j.id}${opts.test ? " (staging test)" : ""}`);
  if (!opts.test) require("./streaks").note(u.userId, "relay");     // 1.99xi: 🔥 chatting into a pad's room from the web keeps the daily streak
  return { status: 200, body: { ok: true, id: j.id, cid: cid || null } };
}

/** 1.99ye: why web relay `flag` can't be used in pad room R right now -> {status, body} | null. `gated` = the pad has no
 *  💎 bridge perk (bridge.js: the room is live but its web side is Prime Time Plus). */
function roomRefusal(R, flag, isLive, gated) {
  if (R && gated && gated(R)) return { status: 403, body: { ok: false, code: "gated", error: "This pad's live chat room comes with 💎 Prime Time Plus." } };
  if (!R || !isLive(R)) return { status: 404, body: { ok: false, code: "offline", error: "That Camfrog room isn't live right now (Pepe isn't in it)." } };
  if (!R[flag]) return { status: 403, body: { ok: false, code: "relay_off", error: "That isn't switched on in this Camfrog room." } };
  return null;
}

function register(app, { isBotToken, addUser, bySlug, isLive, gated = null, liveIds = null }) {
  const me = async (req) => {
    if (!req.user || !req.user.userId) return null;
    return (await getQuery("SELECT userId, username, displayname, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
  };
  const roomFor = (req, res, flag) => {
    const R = bySlug(req.params.slug);
    const why = roomRefusal(R, flag, isLive, gated);
    if (why) { res.status(why.status).json(why.body); return null; }
    return R;
  };

  app.post("/api/rooms/:slug/say", addUser, express.json({ limit: "8kb" }), async (req, res) => {
    const u = await me(req);
    if (!u) return res.status(401).json({ ok: false, code: "signin", error: "Sign in first." });
    const R = roomFor(req, res, "relay");
    if (!R) return;
    // adultgate site: someone the 18+ gate keeps from reading the room doesn't talk into it either (lines and ! commands)
    if (require("./adultgate").refuseJson(req, res, R.id)) return;
    const body = req.body || {};
    // 1.99ye: too long is refused (with the limit), never cut short silently - the composer counts down to SAY_MAX
    const text = clean(body.text, SAY_MAX + 1);
    if (text.startsWith("!")) return runCmd(req, res, u, R, text.slice(0, SAY_MAX));
    if (text.length > SAY_MAX) return res.status(400).json({ ok: false, code: "too_long", max: SAY_MAX, error: `That's too long — ${SAY_MAX} characters at most.` });
    const out = await sayLine(u, R, text, body.cid);
    res.status(out.status).json(out.body);
  });

  // 1.99ye: Pepe's long-poll for relay jobs - answered the moment one is queued (newJob wakes it), else after `wait` s
  // with none. Acks ride along; /api/bridge/relay/ack takes them on their own (Pepe sends one as soon as a line is out).
  app.post("/api/bridge/relay/pull", express.json({ limit: "256kb" }), async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    hookDrain();
    applyAcks(b.acks);
    lastPull = Date.now();
    const ids = () => (liveIds ? liveIds() : new Set());
    let out = draining ? [] : takeJobs(ids(), "pull");
    const wait = Math.min(PULL_WAIT_MAX, Math.max(0, Number(b.wait) * 1000 || 0));
    if (!out.length && wait > 0 && !draining) {
      await new Promise((resolve) => {
        let done = false;
        const fin = () => {
          if (done) return;
          done = true; clearTimeout(t);
          const i = pullers.indexOf(fin); if (i >= 0) pullers.splice(i, 1);
          resolve();
        };
        const t = setTimeout(fin, wait);
        pullers.push(fin);
        res.on("close", fin);
      });
      // Pepe hung up meanwhile (a timeout, a restart): never claim jobs for an answer nobody reads
      if (res.writableEnded || res.destroyed || (req.socket && req.socket.destroyed)) return;
      out = draining ? [] : takeJobs(ids(), "pull");
      lastPull = Date.now();
    }
    const mfc = mfCancelled();                     // micfollow: claimed mic-stage stills to drop (see mfCancelled)
    res.json({ ok: true, jobs: out, ...(mfc.length ? { mf_cancel: mfc } : {}), ...(draining && !out.length ? { retry: true, idle: 3 } : {}) });
  });
  app.post("/api/bridge/relay/ack", express.json({ limit: "256kb" }), (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    applyAcks(b.acks);
    res.json({ ok: true });
  });

  // A "!" line: a command run by Pepe as the account's linked Camfrog login (see the top of the file).
  async function runCmd(req, res, u, R, text) {
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch") return res.status(400).json({ ok: false, error: "Bad request." });
    const c = cmdName(text);
    const cmds = R.cmds || {};
    if (c === "!commands") return res.json({ ok: true, local: true, reply: commandsText(cmds), cmds });
    if (!Object.keys(cmds).length) return res.status(403).json({ ok: false, error: "Commands from the website aren't on in this Camfrog room." });
    if (!u.camfrogUsername) return res.status(403).json({ ok: false, error: "Typed commands run as a chat name - link a chat account first (Settings \u2192 Account \u2192 Connections). The \ud83d\udc38 Pepe menu works with your PATV account." });
    const feat = c === "!sb" ? "soundboard" : "commands";  // 1.99zf: the pad soundboard's buttons are "!sb <id>" lines
    const blk = await blockedWhy(R, u, feat);               // 1.99xa: !bridge block
    if (blk) return res.status(403).json({ ok: false, code: "blocked", error: blk, blocked: true, feature: feat });
    if (!CMD_NAME_RE.test(c) || CMD_DENY.has(c) || !(c in cmds)) {
      return res.status(400).json({ ok: false, error: `${c.slice(0, 30)} isn't available from the website \u2014 type !commands for the list.` });
    }
    // stkfix B3: a command line's stickers follow the say rule (packs this account owns, 12 at most, the length written out),
    // and Camfrog gets "[sticker: Name]" (B2) - never a raw token, never one from a pack this account doesn't own
    const out = require("./stickers").fallbackText(text);
    const st = await stickerRefusal(u, text, out);
    if (st) return res.status(st.status).json(st.body);
    text = out;
    const lim = limited("cmd|" + u.userId, CMD_GAP, CMD_BURST, CMD_WINDOW);
    if (lim) return res.status(429).json({ ok: false, error: lim });
    const j = newJob({ kind: "cmd", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername, text });
    console.log(`[bridge-relay] cmd room=${R.id} account=${u.username} camfrog=${u.camfrogUsername} cmd=${c} job=${j.id}`);
    cmdLog({ userId: u.userId, username: u.username, camfrog: u.camfrogUsername, room: R.id, command: text, job: j.id, status: "pending", result: "" });
    res.json({ ok: true, id: j.id, cmd: true });
  }

  // Admins: the web command audit (newest first). ?room= / ?camfrog= filter; ?limit= up to 500.
  app.get("/api/bridge/cmdlog", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const a = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!SP.can(a, "bridge.cmdlog")) return res.status(403).json({ ok: false, error: "Admins only." });
    await cmdLogReady;
    const where = [], args = [];
    if (req.query.room) { where.push("room = ?"); args.push(String(req.query.room).slice(0, 80)); }
    if (req.query.camfrog) { where.push("LOWER(camfrog) = ?"); args.push(String(req.query.camfrog).toLowerCase().slice(0, 40)); }
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    const rows = await getQuery(`SELECT ts, username, camfrog, room, command, status, result FROM bridge_cmd_log
                                 ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, [...args, limit]);
    res.json({ ok: true, rows });
  });

  app.post("/api/rooms/:slug/clip", addUser, express.raw({ type: ["audio/*", "application/octet-stream"], limit: CLIP_MAX_BYTES }), async (req, res) => {
    const u = await me(req);
    if (!u) return res.status(401).json({ ok: false, error: "Sign in first." });
    const R = roomFor(req, res, "micRelay");
    if (!R) return;
    if (require("./adultgate").refuseJson(req, res, R.id)) return;          // adultgate site: no voice clips into it past the gate
    if (!u.camfrogUsername) return res.status(403).json({ ok: false, error: "Link your Camfrog name first: type !verify in a Camfrog room with Pepe." });
    const blk = await blockedWhy(R, u, "voice");            // 1.99xa: !bridge block
    if (blk) return res.status(403).json({ ok: false, code: "blocked", error: blk, blocked: true, feature: "voice" });
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    const secs = Number(req.get("x-clip-secs")) || 0;
    if (!buf || buf.length < 500) return res.status(400).json({ ok: false, error: "That recording is empty." });
    if (secs > CLIP_MAX_SECS + 1) return res.status(400).json({ ok: false, error: `Keep it under ${CLIP_MAX_SECS} seconds.` });
    const mime = String(req.get("content-type") || "audio/webm").split(";")[0].slice(0, 40);
    const lim = limited("clip|" + u.userId, 30000, 3, 600000);
    if (lim) return res.status(429).json({ ok: false, error: lim });
    const j = newJob({ kind: "clip", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername, display: await webName(u), data: buf, mime, secs });
    console.log(`[bridge-relay] clip room=${R.id} account=${u.username} camfrog=${u.camfrogUsername} bytes=${buf.length} job=${j.id}`);
    res.json({ ok: true, id: j.id });
  });

  // Pepe fetches a clip's audio once; it's dropped from memory right after.
  app.post("/api/bridge/clip", express.json({ limit: "8kb" }), (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    const j = jobs.get(String(b.id || ""));
    if (!j || j.kind !== "clip" || !j.data) return res.status(404).json({ ok: false });
    const data = j.data.toString("base64");
    j.data = null;
    res.json({ ok: true, mime: j.mime, data });
  });

  app.post("/api/rooms/:slug/snap", addUser, express.json({ limit: "4kb" }), async (req, res) => {
    const u = await me(req);
    if (!u) return res.status(401).json({ ok: false, error: "Sign in first." });
    const R = roomFor(req, res, "cams");
    if (!R) return;
    if (!(await padFull(u.userId, R.id))) return res.status(403).json(PAD_DENIED);
    const blk = await blockedWhy(R, u, "snapshots");        // 1.99zf: a bridge block on cam snapshots
    if (blk) return res.status(403).json({ ok: false, code: "blocked", error: blk, blocked: true, feature: "snapshots" });
    const login = String((req.body || {}).login || "").toLowerCase().slice(0, 40);
    const m = R.members.find((x) => !x.anon && String(x.login).toLowerCase() === login);
    if (!m || !m.on_cam || m.self) return res.status(400).json({ ok: false, error: "They aren't on cam." });
    const ref = await CV().camRefusal(login, u.userId);
    if (ref) return res.status(ref.status).json({ ok: false, code: ref.code, error: ref.error });
    const key = R.id + "|" + login;
    const cached = snaps.get(key);
    // Whoever asks shares the frame they're shown - and only they may save it (Save snap, 1.99ap).
    // Pepe judged the save rule for whoever's request opened the cam; another viewer riding on that
    // frame gets Save only where the room lets everyone !snap.
    if (cached && Date.now() - cached.ts < SNAP_TARGET_GAP) {
      if (cached.viewers) cached.viewers.add(u.userId);
      if (cached.ok) CV().noteView("snap", R.id, login, u);
      return res.json({ ok: true, cached: true });
    }
    for (const j of jobs.values()) {
      // (never a 🎙 mic-stage still's job: that frame is never a viewer's - no Save, no Generate, no clip)
      if (j.kind === "snap" && !isMfSnap(j) && j.roomId === R.id && j.target === login && j.state !== "done") {
        if (j.viewers) j.viewers.add(u.userId);
        return res.json({ ok: true, pending: true });
      }
    }
    const lim = limited("snap|" + u.userId, SNAP_VIEWER_GAP, 6, 60000);
    if (lim) return res.status(429).json({ ok: false, error: lim });
    const j = newJob({ kind: "snap", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername || "",
      target: login, viewers: new Set([u.userId]), ghost: (() => { try { return require("./ghost").isGhost(u.userId); } catch (e) { return false; } })() });
    console.log(`[bridge-relay] snap room=${R.id} viewer=${u.username} target=${login} job=${j.id}`);
    res.json({ ok: true, id: j.id });
  });

  // Pepe posts the frame (or why there isn't one).
  app.post("/api/bridge/snap", express.json({ limit: "1mb" }), (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    const j = jobs.get(String(b.id || ""));
    const roomId = String(b.room || (j && j.roomId) || ""), login = String(b.target || (j && j.target) || "").toLowerCase().slice(0, 40);
    if (!roomId || !login) return res.status(400).json({ ok: false });
    let img = null;
    if (b.ok && typeof b.data === "string") {
      img = Buffer.from(b.data, "base64");
      if (img.length > 400 * 1024 || img[0] !== 0xff || img[1] !== 0xd8) img = null;      // JPEG only, small
    }
    // The save rule Pepe sent for the viewer whose request opened the cam (older Pepes send none:
    // then nobody gets Save).
    const rule = ["on", "admins", "no"].includes(b.save) ? b.save : null;
    const cost = Math.max(0, parseInt(b.cost, 10) || 0);
    const okFor = new Map();
    if (isMfSnap(j) || mfIds.has(String(b.id || ""))) {
      // micfollow: a 🎙 mic-stage still - its own store (never a viewer's snapshot: no save rule, no viewers, no Generate).
      // A cancelled one (the person was cut / the tile left while Pepe took it) is dropped unseen.
      const cancelled = (j && j.cancelled) || mfIds.get(String(b.id || "")) === true;
      if (j) { j.state = "done"; j.doneAt = Date.now(); j.result = { ok: !!img && !cancelled, msg: cancelled ? "cancelled" : clean(b.status, 120) }; }
      if (cancelled) return res.json({ ok: true, cancelled: true });
      mfSnaps.set(roomId + "|" + login, { ts: Date.now(), ok: !!img, img });
      // 1.99afl (S1): Pepe's structured result code (bot 1.99afk) - soft refusals retry soon, list_unread pauses the room; an
      // older Pepe sends none (soft). Never the free-text status.
      const code = typeof b.code === "string" && /^[a-z_]{1,24}$/.test(b.code) ? b.code : null;
      try { require("./micfollow").onStillResult(roomId, login, !!img, code); } catch (e) { /* no mic follows */ }
      return res.json({ ok: true });
    }
    if (img && j && rule && rule !== "no" && b.viewer_ok) okFor.set(j.userId, cost);
    snaps.set(roomId + "|" + login, { sid: "f" + crypto.randomBytes(9).toString("hex"), ts: Date.now(), ok: !!img, status: clean(b.status, 120), img,
      viewers: new Set(j && j.viewers ? j.viewers : []), rule, okFor, cost, saves: new Map() });
    if (j) { j.state = "done"; j.result = { ok: !!img, msg: clean(b.status, 120) }; }
    // 1.99yq: everyone this frame is shown to opened their cam - Pepe tells the owner (only once there IS a picture)
    if (img && j && j.viewers) CV().noteViewers("snap", roomId, login, [...j.viewers]);
    res.json({ ok: true });
  });

  app.get("/api/rooms/:slug/snap/:login", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const R = bySlug(req.params.slug);
    if (!R || !R.cams) return res.status(404).json({ state: "off" });
    if (!(await padFull(req.user.userId, R.id))) return res.status(403).json(PAD_DENIED);
    const login = String(req.params.login || "").toLowerCase().slice(0, 40);
    const ref = await CV().camRefusal(login, req.user.userId);         // 1.99yq: blocked / switched off since the frame was taken
    if (ref) return res.json({ state: "refused", status: ref.error });
    const s = snaps.get(R.id + "|" + login);
    const pending = [...jobs.values()].some((j) => j.kind === "snap" && !isMfSnap(j) && j.roomId === R.id && j.target === login && j.state !== "done");
    if (s && (!pending || Date.now() - s.ts < SNAP_TARGET_GAP)) {
      let save = null;
      if (s.ok && s.img && saveRight(s, req.user.userId) !== null) {
        const u = await me(req);
        if (u && u.camfrogUsername) save = { sid: s.sid, cost: saveRight(s, req.user.userId), until: s.ts + SNAP_TTL, id: s.saves.get(req.user.userId) || null };
      }
      // 1.99dr: "✨ Use in Generate" - any viewer shown this frame may use it as an AI reference picture
      // (aigen.js claims it by sid, re-checking the room and the person; priced like chat's -cam)
      const gen = s.ok && s.img && s.viewers && s.viewers.has(req.user.userId) ? { sid: s.sid, until: s.ts + SNAP_TTL } : null;
      // 1.99ez: "🎬 Clip" (camclip.js) - the lengths, and why it's greyed out here (null = it isn't)
      let clip = null;
      if (s.ok && s.img) { try { clip = await require("./camclip").clipInfo(R, req.user.userId, login); } catch (e) { clip = null; } }
      return res.json({ state: s.ok ? "ok" : "refused", ts: s.ts, status: s.status, save, gen, clip,
        img: s.img ? "data:image/jpeg;base64," + s.img.toString("base64") : null });
    }
    res.json({ state: pending ? "pending" : "none" });
  });

  // -- Save snap (1.99ap) --
  // JSON + X-Requested-With only (a cross-site form can't send it). The browser names the frame; the
  // server checks it's one this account was shown and that it's still fresh, then queues the action.
  app.post("/api/rooms/:slug/snap/save", addUser, express.json({ limit: "4kb" }), async (req, res) => {
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch") return res.status(400).json({ ok: false, error: "Bad request." });
    const u = await me(req);
    if (!u) return res.status(401).json({ ok: false, error: "Sign in first." });
    const R = roomFor(req, res, "cams");
    if (!R) return;
    if (!(await padFull(u.userId, R.id))) return res.status(403).json(PAD_DENIED);
    if (!u.camfrogUsername) return res.status(403).json({ ok: false, error: "Link your Camfrog name first: type !verify in a Camfrog room with Pepe." });
    const blk = await blockedWhy(R, u, "snapshots");        // 1.99zf
    if (blk) return res.status(403).json({ ok: false, code: "blocked", error: blk, blocked: true, feature: "snapshots" });
    const sid = String((req.body || {}).sid || "").slice(0, 40);
    let s = null, login = "";
    for (const [k, v] of snaps) if (sid && v.sid === sid && k.startsWith(R.id + "|")) { s = v; login = k.slice(R.id.length + 1); break; }
    if (!s || !s.ok || !s.img || Date.now() - s.ts >= SNAP_TTL) return res.status(410).json({ ok: false, error: "That snapshot expired — take a fresh one." });
    if (!s.viewers || !s.viewers.has(u.userId)) return res.status(403).json({ ok: false, error: "That isn't a snapshot you asked for." });
    if (saveRight(s, u.userId) === null) return res.status(403).json({ ok: false, error: "Snaps of them aren't allowed here." });
    const ref = await CV().camRefusal(login, u.userId, { strict: true });   // 1.99aak: a 👻 ghost can't SAVE past the owner's rules
    if (ref) return res.status(ref.status).json({ ok: false, code: ref.code, error: ref.error });
    const prev = s.saves.get(u.userId);
    if (prev) {
      const a = (await getQuery("SELECT status FROM pepe_actions WHERE id = ? AND user_id = ?", [prev, u.userId]))[0];
      if (a && a.status !== "failed") return res.json({ ok: true, id: prev, again: true });   // one save per frame
    }
    const lim = limited("savesnap|" + u.userId, SAVE_GAP, SAVE_BURST, SAVE_WINDOW);
    if (lim) return res.status(429).json({ ok: false, error: lim });
    const fid = "f" + crypto.randomBytes(12).toString("hex");
    frames.set(fid, { img: s.img, userId: u.userId, username: u.username, roomId: R.id, login, ts: Date.now() });
    try {
      const id = await queueAction(u.userId, { kind: "snap.save", args: [R.id, login, fid], tag: "snap", label: "!snap " + login });
      s.saves.set(u.userId, id);
      console.log(`[bridge-relay] save-snap room=${R.id} viewer=${u.username} camfrog=${u.camfrogUsername} target=${login} action=${id}`);
      res.json({ ok: true, id });
    } catch (e) {
      frames.delete(fid);
      res.status(e.message === "busy" ? 429 : 500).json({ ok: false, error: e.message === "busy" ? "You already have a few things waiting — give Pepe a moment." : "Something went wrong — nothing was sent." });
    }
  });

  app.get("/api/rooms/:slug/snap/save/:id", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const a = (await getQuery("SELECT status, message FROM pepe_actions WHERE id = ? AND user_id = ? AND kind = 'snap.save'",
      [parseInt(req.params.id, 10) || 0, req.user.userId]))[0];
    if (!a) return res.status(404).json({ ok: false, error: "No such save." });
    const msg = a.message || "";
    const m = msg.match(/\/media\/([a-f0-9]{8,32})\b/i);
    res.json({ ok: true, status: a.status, message: msg, url: a.status === "done" && m ? "/media/" + m[1] : null });
  });

  // Pepe fetches a queued frame (bot token), checked against the account the save was queued for.
  app.post("/api/bridge/snapframe", express.json({ limit: "4kb" }), (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    const f = frames.get(String(b.id || ""));
    if (!f || Date.now() - f.ts > FRAME_TTL || String(b.user || "") !== f.username) return res.status(404).json({ ok: false });
    res.json({ ok: true, room: f.roomId, target: f.login, data: f.img.toString("base64") });
  });
}

/**
 * micfollow: a still of `login`'s cam for the pad's 🎙 mic stage (the degrade tier between a live tile and a name card).
 * Reuses only ITS OWN kind: a mic-stage frame younger than SNAP_TARGET_GAP or a mic-stage job already on its way - never a
 * viewer's snapshot or a viewer's job (Pepe takes those with his usual targeting, which may pick the wrong "Bob"). Else it
 * queues a quiet job with NO viewer (mf: true - Pepe opens it by its exact name, writes no save rule, logs it at most every
 * 30 min). Nobody can save it or use it for an AI picture: it has no requesting viewer. -> {cached} | {pending} | {id}
 */
function mfSnap(roomId, login) {
  const key = roomId + "|" + login;
  const cached = mfSnaps.get(key);
  if (cached && Date.now() - cached.ts < SNAP_TARGET_GAP) return { cached: true };
  for (const j of jobs.values()) if (isMfSnap(j) && j.roomId === roomId && j.target === login && j.state !== "done") return { pending: true };
  const j = newJob({ kind: "snap", roomId, userId: null, username: null, camfrog: "", target: login, viewers: new Set(), mf: true });
  mfIds.set(j.id, false);
  if (mfIds.size > 2000) mfIds.delete(mfIds.keys().next().value);
  return { id: j.id };
}
/** A mic-stage still job that is no longer wanted: done, never offered (again), its answer dropped. */
function cancelJob(j) {
  j.state = "done"; j.doneAt = Date.now(); j.cancelled = true; j.result = { ok: false, msg: "cancelled" };
  mfIds.set(j.id, true);
  mfCancelAt.set(j.id, j.doneAt);
  if (mfCancelAt.size > 500) mfCancelAt.delete(mfCancelAt.keys().next().value);
}
/** micfollow -> Pepe: the mic-stage still jobs cancelled in the last MF_CANCEL_KEEP_MS (ids). He drops any of them he
 *  claimed: no cam open, no frame sent (older Pepes ignore the field - the site drops their late frame anyway). */
function mfCancelled(now = Date.now()) {
  const out = [];
  for (const [id, at] of [...mfCancelAt]) {
    if (now - at > MF_CANCEL_KEEP_MS) { mfCancelAt.delete(id); continue; }
    out.push(id);
  }
  return out.slice(-200);
}
/** Is this mic-stage still job still wanted? (micfollow.stillWanted: a still tile, the person may still be shown) */
function mfStillWanted(j) {
  try { return require("./micfollow").stillWanted(j.roomId, j.target) === true; } catch (e) { return false; }
}
/** micfollow: the mic stage stopped `login`'s still (the tile went live / left / was cut): cancel the queued (or claimed)
 *  job - Pepe is never handed it (again) and its frame is dropped - and forget the last frame. -> jobs cancelled */
function mfSnapCancel(roomId, login) {
  let n = 0;
  const l = String(login || "").toLowerCase();
  for (const j of jobs.values()) if (isMfSnap(j) && j.roomId === roomId && j.target === l && j.state !== "done") { cancelJob(j); n++; }
  mfSnaps.delete(roomId + "|" + l);
  return n;
}
/** micfollow: the mic stage's still of `login` (the route checked the viewer) - only an exact (mf) frame.
 *  -> {state: ok | refused | pending | none, ts, img} */
function mfFrame(roomId, login) {
  const s = mfSnaps.get(roomId + "|" + login);
  const pending = [...jobs.values()].some((j) => isMfSnap(j) && j.roomId === roomId && j.target === login && j.state !== "done");
  if (s && (!pending || Date.now() - s.ts < SNAP_TARGET_GAP)) {
    return s.ok && s.img ? { state: "ok", ts: s.ts, img: "data:image/jpeg;base64," + s.img.toString("base64") } : { state: "refused" };
  }
  return { state: pending ? "pending" : "none" };
}

/**
 * 1.99dr: a snapshot this viewer was shown, for use as an AI reference picture (aigen.js claimCamRef).
 * -> {login, img, ts} or {error, status}. Only the room's own frames, only fresh ones, only for an account that
 * asked for (or rode on) that frame - the same rule as Save snap's "a snapshot you asked for".
 */
function snapForGen(roomId, sid, userId) {
  sid = String(sid || "").slice(0, 40);
  for (const [k, s] of snaps) {
    if (!sid || s.sid !== sid || !k.startsWith(roomId + "|")) continue;
    if (!s.ok || !s.img || Date.now() - s.ts >= SNAP_TTL) return { status: 410, error: "That snapshot expired — take a fresh one." };
    if (!s.viewers || !s.viewers.has(userId)) return { status: 403, error: "That isn't a snapshot you asked for." };
    const login = k.slice(roomId.length + 1);
    // 1.99yq: the owner's switch and blocks (sync parts; Pepe re-checks private / hidden himself)
    try {
      if (require("./livecam").optedOut(login)) return { status: 403, error: CV().MSG.opted_out };
      if (CV().blocked(login, userId)) return { status: 403, error: CV().UNAVAILABLE };
    } catch (e) { /* the modules are there */ }
    return { login, img: s.img, ts: s.ts };
  }
  return { status: 410, error: "That snapshot expired — take a fresh one." };
}

/** The price this viewer would pay to save snapshot `s`, or null if the !snap rules say no. */
function saveRight(s, userId) {
  if (!s || !s.rule || s.rule === "no") return null;
  if (s.okFor && s.okFor.has(userId)) return s.okFor.get(userId);
  return s.rule === "on" && s.viewers && s.viewers.has(userId) ? s.cost : null;
}

module.exports = { padFull, PAD_DENIED, register, takeJobs, webName, accountRefusal, applyAcks, mineFor, saveRight, snapForGen, SNAP_TTL, cleanCmds, commandsText, CMD_DENY,
  mfSnap, mfFrame, mfSnapCancel, mfCancelled, SNAP_TARGET_GAP,                             // micfollow
  sayLine, roomRefusal, noteEcho, echoJob, setNotify, latency, SAY_MAX, SAY_QUEUE_MAX, SAY_MINUTE_MAX, SAY_PENDING_TTL, SAY_PENDING_TTL_SYNC, SAY_CLAIM_TTL,   // 1.99ye
  _cids: cids, _pullers: pullers, _lastPull: () => lastPull,
  newJob, limited, cmdLog, clean, cleanReply, CMD_GAP, CMD_BURST, CMD_WINDOW,          // 1.99co: the pad Manage panel (padmod.js)
  _sweep: sweep, _jobs: jobs, _snaps: snaps, _mfSnaps: mfSnaps, _mfIds: mfIds, _frames: frames, _hits: hits };
