// Server-built captures of the viewer's mic stage. The browser supplies no media. A snap re-reads
// the viewer's program after obtaining frames; a forward clip fixes its layout, rechecks consent
// every 500 ms, and permanently blanks a tile when it leaves or becomes private. Covers never
// resolve an identity or open a camera. Only cams actually drawn enter stage_capture_people.
// Temporary loopback RTSP permissions exist only while their job holds a path. Readers copy the
// live streams without occupying feedmedia's encoding queue; the final composition uses that queue.
// Room audio is future-only, with hidden/private turns muted. Missing hm metadata drops ALL audio.
// stagecap owns database rows, previews, billing and publishing; this module owns only active jobs.
// mic keep (handoff 16 follow-up, owner 2026-11-01): every finished job also reports `cards` (the logins shown openly only as a
// name card) and `veiled` - true unless everyone in it was shown openly: no cover tile, no blank tile (whatever blanked it), no tile
// that stopped because its person went private / hidden / incognito or withdrew (a tile that leaves when they leave the mic is
// fine), no "Someone is speaking" card, and - while the clip carries room audio - no muted stretch and no voice of a person the
// tiles don't show (noteVoices). stagecap stores the flag (never who was veiled); storykeep keeps / posts only unveiled captures.
// Review fixes: "muted" = a mute that may hide a hidden / private speaker (audioPlan's private_s) - not the lead-in every clip with
// MP3 latency has; a clip's last mic-list read waits out Pepe's MIC_LAG after its end (lastRoster: a late grab is muted when private,
// unseen when not shown); a holder without Pepe's `proven` is never a shown tile; recheck() covers the name cards too.
// 1.99ahq stage cover: a name card draws the person's cover picture (stagecover.js - by default their GTF avatar) instead of the
// letter; covers of veiled speakers stay hoods.
// 1.99ahq stage cover fix 3 (owner 2026-11-02: snaps and clips replicate what the snapper / clipper sees): a card draws exactly the
// cover the VIEWER's program carries (their own stage: none on a tile they reported / are blocked from, none on a veiled tile) - a
// profile photo too, round as the page crops it: stagecover.captureImage fetches it server-side from the site's allow-listed photo
// hosts only (cached; failing to the letter, never failing the capture). The 500 ms samples never wait on a picture (covers: false).
// 1.99ahq review fix 3: neither does start() - a capture starts at once; a snap loads the covers of its final frame (each tile's
// consent read AFTER its picture, so nobody who went hidden / private meanwhile is drawn), a clip at its cut (loadCovers: the cover
// each card carried at the END, read again then - a picture taken down or changed during the recording is never drawn; the end state
// shows for the whole clip). Known divergence, deliberate since handoff 16 (an owner decision to change): a tile the viewer may not
// watch - members_only / unavailable - shows its name card with the cover and the reason on the page, but a capture draws it BLANK
// (no name, no cover): a cam the viewer can't watch is never in a capture, not even by name. hidden / blocked tiles: blank on both.
// 1.99aid (privacy controls V-1, owner Q4): an incognito person's cam tile / 📌 pin is drawn with its CAM (live or still) under its frog-name
// label ("<frog> · incognito") - the person resolved server-side from the tile's id (micfollow.vidVeil / pinByVid), never the id taken
// for a login; their consent is their own rules under THAT frog-name session (never the incognito half of `hidden`); otherwise - and in
// every state with no picture - the peek hood, as before. A capture with such a tile is `veiled` (storykeep never keeps it), its login
// is recorded server-only as `vpeople` (stage_capture_people.veil - forget-me, account deletion and the block rule keep working; never
// a card, never "Remove me" / a notice / anything a page shows), and its recheck asks they're still incognito (a capture under their
// frog name is never published once they show by name).
// 1.99aid (privacy controls S3, micfollow_cfg withheld_cover - dark): a WITHHELD cam (!livecam off, the mic-stage switch off, cam access
// followers / request) is its person's NAME CARD with their cover - drawn without camRefusal (cardConsent: hidden, private and their
// own cam blocks of the viewer only), never its relay or a still; it counts as a name card (`cards`), so the capture stays postable.
// While the switch is on every name card takes cardConsent (the samples, the recheck, storykeep's role "card") - a cam opt-out no
// longer withdraws an appearance by name. Off: consent() everywhere, as before.
// 1.99aih (privacy controls round 6): consent() and cardConsent() also ask a DM block either way between the person and the viewer (the
// block the viewer's stage program already reads - micfollow.dmBlocked), so a capture taken before the person blocked the viewer in DMs
// is never saved or posted by name after it (their cam blocks were asked already). A viewer the person blocked, by cam or DM, reads
// their tile as the letter and "isn't available" (micfollow.viewFor), which a capture draws blank.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const W = 1280, H = 720, FOOT = 32, DARK = "#10151d", CLIP_MIN = 3;
const MIC_LAG = 2;   // review fix: Pepe's mic list reaches the site up to ~2 s after a grab (s)
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const JOBS = new Map(), SNAP_AT = new Map();
const CID = /^c[a-f0-9]{20}$/, LOGIN = /^[a-z0-9_.-]{1,64}$/i;
const MSG = {
  empty: "Nobody is on the mic right now.", home: "Open the pad to snap or clip its mic stage",
  disabled: "Mic-stage captures are off right now.", busy: "Busy — try again in a minute.",
  denied: "This pad is not available to this account.", unavailable: "Captures are unavailable in this pad.",
  recording: "Someone is clipping this stage right now — try again in {secs} s",
  snap_wait: "Please wait a moment before snapping this stage again.",
  short: "The recording stopped before there was enough to keep.",
  failed: "Couldn’t capture the mic stage just now — nothing was charged.",
  revoked: "Someone in this capture turned off captures of their cam."
};
let deps = {
  now: () => Date.now(), config: () => require("./mainstage").config(),
  eligibility: u => require("./stagecap").eligibility(u), killed: k => require("./stagecap").killed(k),
  roomOff: id => require("./stagecap").roomOff(id),
  resolveRoom: id => require("./roomsweb").resolveRoom(id),
  account: async id => (await require("./dbUtils").getQuery("SELECT * FROM users WHERE userId = ?", [id]))[0],
  people: async id => (await require("./dbUtils").getQuery("SELECT login FROM stage_capture_people WHERE capture_id = ?", [id])).map(x => x.login),
  // mic keep review: the logins a capture shows only as a name card (stagecap's stage_capture_cards) - recheck() covers them too
  cards: async id => (await require("./dbUtils").getQuery("SELECT login FROM stage_capture_cards WHERE capture_id = ?", [id])).map(x => x.login),
  full: async (u, id) => { const p = require("./padaccess"); await p.init(); return p.full(u, id); },
  block: (id, u, kind) => require("./bridgeblocks").refusal(id, u, kind),
  // audiogate2 (listenban.js): a clip records the pad's room audio - a pad ban, a whole-bridge block or a network ban (net = the request's
  // network, memory only) stops it like an access loss; a check that fails lets it through (no answer is not a no)
  listenBan: async (id, u, net) => {
    try { return !!(await require("./listenban").refusal({ roomId: id, user: u, net: net || null })); }
    catch (_) { console.error("[stagemiccap] audiogate2: 1 ban check failed - let through"); return false; }
  },
  clipSwitch: id => require("./bridge").clipSwitch(id), clipOffText: id => require("./bridge").clipOffText(id),
  liveShown: id => { try { const B = require("./bridge"), r = B._rooms.get(id); return !!r && B.isLiveShown(r); } catch (_) { return false; } },
  // review fix 2: the 💎 Prime Time Plus bridge perk alone (what bridge.bridgeOk asks; failing closed here) - no liveness in it
  bridgeOk: id => { try { return require("./premium").bridgeAllowed(String(id)) === true; } catch (_) { return false; } },
  program: (id, u) => require("./bridge").stageProgramFor(id, u),
  camRefusal: (l, u, o) => require("./camviewers").camRefusal(l, u, o),
  // 1.99aid (privacy controls S3): micfollow_cfg withheld_cover - a cam opt-out is a NAMED card (cardConsent); the person's cam blocks
  withheldOn: () => { try { return require("./micfollow").withheldCover() === true; } catch (_) { return false; } },
  camBlocked: async (l, u) => { const C = require("./camviewers"); await C.init(); return C.blocked(l, u) === true; },
  // 1.99aih (privacy controls round 6): a DM block either way between the person and the viewer (micfollow.dmBlocked - the block the
  // viewer's stage program reads; fails closed)
  dmBlocked: (l, u) => require("./micfollow").dmBlocked(String(l).toLowerCase(), String(u)),
  hidden: l => require("./quotes").isHidden(l),
  // 1.99aid (privacy controls V-1): a veiled cam tile / pin -> {login, sess} (server-only), its session's own path, the veil checks
  vtile: (id, eid, pin) => { const MF = require("./micfollow"); if (pin) { const p = MF.pinByVid(id, eid); return p && p.veil ? { login: p.login, sess: p.veil.sess } : null; } return MF.vidVeil(id, eid); },
  vpath: (id, l) => require("./livecam").sessPath(id, l),
  stillVeiled: (R, l, sess) => require("./incogcams").stillVeiled(R, l, sess),
  personIncognito: l => require("./incogcams").personIncognito(l),
  veiledPeople: async id => (await require("./dbUtils").getQuery("SELECT login FROM stage_capture_people WHERE capture_id = ? AND veil IS NOT NULL", [id])).map(x => x.login),
  exact: (id, l) => require("./livecam").mfState(id, l).exact === true,
  pin: (id, l) => require("./micfollow").pinOf(id, l),
  camPath: (id, l) => require("./livecam").pathFor(id, l),
  still: (id, l) => require("./bridge-relay").mfFrame(id, l),
  audioTap: (id, fn, u) => require("./bridge").audioTap(id, fn, u),
  offset: (id, p) => require("./avsync").serverOffsetMs(id, p, "mp3"),
  // 1.99ahq stage cover: a name card's picture (stagecover.captureImage - fix 3: local data, or a profile photo fetched server-side
  // from an allow-listed host only, cached; null = the letter)
  cover: url => require("./stagecover").captureImage(url),
  mic: id => { const r = require("./bridge")._rooms.get(id); return r && r.mic; },
  privateLogins: ls => privateLoginsStrict(ls),
  note: (kind, id, l, u) => require("./camviewers").noteViewers(kind, id, l, [String(u)]),
  fm: () => require("./feedmedia"), reader: null,
  privacyWaitMs: 1500,  // review fix 2: how long a cut waits for a private-profile lookup still in flight (settlePrivacy)
  lastRosterWaitMs: MIC_LAG * 1000   // mic keep review: a clip's last mic-list read waits (at most) this long after its end (lastRoster)
};
const DEFAULT_DEPS = Object.freeze({ ...deps });   // review fix 2: (tests) the real checks, to put back after a stub
function configure(d) { deps = { ...deps, ...d }; }
// stories.privateLogins intentionally tolerates a missing users table for its feed callers. A
// recorder cannot interpret that database failure as public consent. Apply its same two profile
// sections here, retaining errors so privateSample can mute the complete unknown interval.
async function privateLoginsStrict(logins, read, layout) {
  const ls = [...new Set(logins.map(l => String(l).toLowerCase()).filter(l => LOGIN.test(l)))];
  if (!ls.length) return new Set();
  const query = read || require("./dbUtils").getQuery;
  const users = await query(`SELECT userId, camfrogUsername FROM users WHERE lower(camfrogUsername) IN (${ls.map(() => "?").join(",")})`, ls);
  const pl = layout || require("./profilelayout"), out = new Set();
  for (const u of users) {
    const L = layout ? await pl.get(u.userId) : await privateLayoutStrict(u.userId, query, pl);
    if (pl.stateOf(L, "analytics") === "hidden" || pl.stateOf(L, "an_rooms") === "hidden") out.add(String(u.camfrogUsername).toLowerCase());
  }
  return out;
}
async function privateLayoutStrict(userId, query, pl) {
  await pl.ready;
  const row = (await query("SELECT layout FROM profile_layout WHERE user_id = ?", [String(userId)]))[0];
  if (!row) return pl.sanitize(pl.DEFAULT); // no saved preference uses the site's public default
  const raw = JSON.parse(row.layout); // profilelayout.get falls back to public for corrupt JSON
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw.hidden != null && !Array.isArray(raw.hidden))) throw Error("Unreadable privacy preference");
  return pl.sanitize(raw);
}
function refuse(key, status = 403, vars) {
  const e = new Error((MSG[key] || key).replace(/\{(\w+)\}/g, (m, k) => vars && vars[k] != null ? vars[k] : m));
  Object.assign(e, { status, refuse: true, i18n: MSG[key] ? "stagecap.mic." + key : undefined, vars }); return e;
}
function sanitize(s) { return String(s || "").replace(/stagecap(?::|%3a)[^\s/@]*@/ig, "stagecap:[redacted]@"); }
function text(s, limit = 40) {
  // Pictographs are omitted: production servers need no emoji font. Slice Unicode code points.
  const a = Array.from(String(s || "").replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u0000-\u001f\u007f]/gu, "").trim());
  return (a.length > limit ? a.slice(0, limit - 1).join("") + "…" : a.join("")).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}
function entries(p) {
  // wave2 WP-4 (F.3): with a dynamic template (program.dyn) a tile the viewer reported stays a cell - tileFor blanks it - so the
  // capture keeps the template the viewer's own page shows ("hidden for you" there); without dyn it is left out as before
  const keepHidden = !!(p && p.dyn);
  return (p && Array.isArray(p.src) ? p.src : []).filter(e => e && typeof e.id === "string" && /^[\w.-]{1,64}$/.test(e.id) && (keepHidden || e.watch !== "hidden"))
    .slice(0, 9).sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0));
}
function speaking(p) { return p && (p.speaking === "someone" || p.speaking === "pepe") ? p.speaking : null; }
function usable(p) { return !!(p && !p.signin && !p.blocked && p.on !== false && (entries(p).some(e => e.watch !== "hidden") || speaking(p))); }
async function programFor(R, user) { return deps.program(R.id, user.userId); }

/** 1.99ahp STABLE SLOTS: each legacy layout's cells / columns - MUST equal stage-mic.js CELLS / COLS (test/micfollow-ui.test.js). */
const CELLS = Object.freeze({ single: 1, split: 2, grid4: 4, grid9: 9, pip: 2 }), COLS = Object.freeze({ single: 1, split: 2, grid4: 2, grid9: 3, pip: 1 });
/** 1.99ahp STABLE SLOTS (program.stable): each entry's cell is its place (pos) - an empty place stays an empty cell; two on one
 *  place take the next free one; more places than cells (or dense: the dynamic templates) close up in place order. The page's
 *  stage-mic.js slotCells does exactly this. -> [entry | null] */
function slotCells(sorted, cells, dense) {
  const out = [];
  for (const s of sorted) {
    let p = Math.min(64, Math.max(0, Math.floor(Number(s.pos)) || 0));
    while (out[p]) p++;
    out[p] = s;
  }
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = null;
  return dense || out.length > cells ? out.filter(Boolean) : out;
}
/** CSS grid rectangles, including the intentional picture-in-picture overlap. No DOM required. 1.99ahp: a stable program
 *  (program.stable) places each tile in its place's cell - what the viewer's page (stage-mic.js) shows. */
function rects(program, width = W, height = H) {
  const es = entries(program), n = es.length, out = [], gap = 2;
  if (!n) return out;
  const dyn = program.dyn, d = dyn && dyn.n === n && dyn.t === "d" + n ? n : 0;
  const stable = program.stable === true;
  // 1.99ahp: stable - the dynamic cells are the places with the main in cell 0 once there are 3+ (it trades places with whoever is
  // there); picture in picture's big picture is place 0; the legacy grids keep empty places as empty cells
  let seq = null;
  if (stable && d) {
    seq = slotCells(es, n, true);
    const mi = seq.findIndex(e => e.id === dyn.main);
    if (seq.length >= 3 && mi > 0) [seq[0], seq[mi]] = [seq[mi], seq[0]];
  } else if (stable && program.layout !== "pip") seq = slotCells(es, CELLS[program.layout] || 1, false);
  const main = stable ? (d ? seq[0] : es[0])
    : d ? es.find(e => e.id === dyn.main) || es[0] : es.find(e => e.newest) || es.filter(e => !e.pin).at(-1) || es[0];
  const add = (e, x, y, w, h) => out.push({ id: e.id, x: Math.round(x), y: Math.round(y),
    w: Math.max(2, Math.min(width, Math.round(x + w)) - Math.round(x)), h: Math.max(2, Math.min(height, Math.round(y + h)) - Math.round(y)) });
  if (!d && program.layout === "pip") {
    add(main, 0, 0, width, height);
    es.filter(e => e !== main).forEach(e => add(e, width * .7 - 8, height * .7 - 8, width * .3, height * .3));
    return out;
  }
  let cols = [1], rows = 1, cells = [];
  if (d) {
    if (d === 2) { cols = [1, 1]; cells = [[0, 0, 1, 1], [1, 0, 1, 1]]; }
    if (d === 3 || d === 4 || d === 7) {
      cols = d === 3 ? [2, 1] : d === 4 ? [3, 1] : [2, 1, 1]; rows = d === 3 ? 2 : 3;
      cells = [[0, 0, 1, rows]];
      for (let y = 0; y < rows; y++) for (let x = 1; x < cols.length; x++) cells.push([x, y, 1, 1]);
    }
    if (d === 5) { cols = [2, 1, 1]; rows = 2; cells = [[0, 0, 1, 2], [1, 0, 1, 1], [2, 0, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]]; }
    if (d === 6 || d === 8 || d === 9) {
      cols = Array(d === 6 ? 3 : 4).fill(1); rows = d === 8 ? 4 : 3;
      const span = d === 8 ? 3 : 2; cells = [[0, 0, span, span]];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols.length; x++) if (x >= span || y >= span) cells.push([x, y, 1, 1]);
    }
  } else {
    const c = program.layout === "grid9" ? 3 : program.layout === "grid4" || program.layout === "split" ? 2 : 1;
    cols = Array(c).fill(1); rows = program.layout === "grid9" ? 3 : program.layout === "grid4" ? 2 : Math.ceil((seq ? seq.length : n) / c);
  }
  // (1.99ahp: a stable program's cells follow its places - seq, null = an empty cell)
  const ordered = seq || (d ? [main, ...es.filter(e => e !== main)] : es);
  if (!cells.length) for (let i = 0; i < ordered.length; i++) cells.push([i % cols.length, Math.floor(i / cols.length), 1, 1]);
  const unit = (width - gap * (cols.length - 1)) / cols.reduce((a, b) => a + b, 0), rh = (height - gap * (rows - 1)) / rows;
  const xs = [0]; for (const c of cols) xs.push(xs[xs.length - 1] + c * unit + gap);
  ordered.forEach((e, i) => { if (!e) return; const [x, y, cw, ch] = cells[i]; add(e, xs[x], y * (rh + gap), xs[x + cw] - xs[x] - gap, ch * rh + (ch - 1) * gap); });
  return out;
}
/** Central alignment point for WP-4. Deliberately never reads a cover's login or id as identity. */
function coverArt(entry) {
  const valid = (entry.veil === "incognito" || entry.veil === "hidden") && Number.isInteger(entry.hood) && entry.hood >= 0 && entry.hood <= 7;
  const file = valid ? path.join(__dirname, "public", "img", "anon", "hood-" + (entry.veil === "hidden" ? "shadow-" : "peek-") + entry.hood + ".svg") : null;
  let art = null;
  try { if (file && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()) art = fs.readFileSync(file); } catch (_) { /* WP-4 not installed yet */ }
  // (wave2 WP-4: a cover without a frog name - today's wire, a C.2 session - is "someone", never " · incognito")
  return { art, label: String(entry.name || "someone") + (valid ? " · " + entry.veil : "") };
}
async function consent(login, userId, veil = null) {
  // review fix: camRefusal treats a failed private-profile lookup as public. The strict lookup throws instead, which refuses here.
  // 1.99aid (privacy controls V-1): `veil` = a frog-name cam - {R, sess}: still incognito under that session (drawing); {sess: null}: still
  // incognito at all (recheck - never published once they show by name). Never the incognito half of `hidden`.
  try {
    const okVeil = veil ? (veil.sess != null ? deps.stillVeiled(veil.R, login, veil.sess) === true : deps.personIncognito(login) === true) : !(await deps.hidden(login));
    // (1.99aih privacy controls round 6: + a DM block either way, as the viewer's stage program reads it - a capture taken before the person
    // DM-blocked the viewer is never saved or posted by name after; their cam blocks were already camRefusal's)
    return okVeil && !(await deps.privateLogins([login])).has(String(login).toLowerCase()) &&
      !(await deps.camRefusal(login, userId, { strict: true })) && !(userId != null && (await deps.dmBlocked(login, userId)));
  } catch (_) { return false; }
}
/** 1.99aid (privacy controls S3): may `login` be drawn BY NAME only - a name card, no cam - for this viewer? While micfollow_cfg
 *  withheld_cover is on, a cam opt-out (!livecam off, cam access) withholds the cam, not the person, so a name card asks everything
 *  consent() does EXCEPT the cam's rules: not hidden, the strict private-profile lookup (fails closed), and not one of the person's own
 *  blocks of this viewer (cam, or DM either way - 1.99aih round 6). Off: consent() exactly (today). Used for every name card (a capture's cards, the samples, the recheck
 *  before a save / post - storykeep's role "card"); a cam drawn always takes consent(). */
async function cardConsent(login, userId) {
  if (!deps.withheldOn()) return consent(login, userId);
  try {
    if (await deps.hidden(login)) return false;
    if ((await deps.privateLogins([login])).has(String(login).toLowerCase())) return false;
    // (1.99aih privacy controls round 6: the person's blocks of this viewer by cam OR DM, either way - as their stage program reads them)
    return !(userId != null && ((await deps.camBlocked(login, userId)) || (await deps.dmBlocked(login, userId))));
  } catch (_) { return false; }
}
/** A named card's stage cover {buf, k} from the program entry's avatar URL - the picture the viewer's own stage shows on that card
 *  (fix 3: a profile photo too - an https URL or the site's /media/cover/p/ proxy; stagecover decides which hosts it may fetch), or
 *  null = the letter. Bounded (COVER_WAIT_MS): a slow picture never holds the capture up. */
const COVER_WAIT_MS = 4000;
async function coverFor(e) {
  const u = typeof e.avatar === "string" ? e.avatar : "";
  if (u.includes("..") || u.length > 600) return null;
  if (!/^\/(?:media\/cover\/[aup]\/|public\/)[\w.~\-/]+$/.test(u) && !/^https:\/\/[^\s"'<>()\\]+$/.test(u)) return null;
  let timer;
  try {
    const c = await Promise.race([deps.cover(u), new Promise(r => { timer = setTimeout(() => r(null), COVER_WAIT_MS); })]);
    return c && Buffer.isBuffer(c.buf) && c.buf.length <= 4 * 1024 * 1024 ? c : null;
  } catch (_) { return null; } finally { clearTimeout(timer); }
}
async function tileFor(e, R, user, { covers = true } = {}) {
  const t = { id: e.id, mode: "blank", newest: !!e.newest, pin: !!e.pin, name: "", source: e };
  if (e.kind === "cover") { const c = coverArt(e); return { ...t, mode: "cover", name: c.label, image: c.art }; }
  // 1.99aid (privacy controls S5 + V-1): an incognito person's cam tile / pin under its frog name - its CAM when the viewer may watch it
  // and the person's own rules allow it (under that frog-name session), else its peek hood; never its id taken for a login. Either way
  // the capture is veiled (storykeep never keeps it)
  if (e.kind === "cam" && e.veil === "incognito") {
    const c = coverArt({ veil: "incognito", hood: e.hood, name: e.name });
    const hood = { ...t, mode: "cover", name: c.label, image: c.art };
    if (e.watch !== "ok") return hood;
    let v = null;
    try { v = deps.vtile(R.id, String(e.id || ""), !!e.pin); } catch (_) { v = null; }
    const vl = v && v.login ? String(v.login).toLowerCase() : "";
    if (!LOGIN.test(vl) || v.sess == null || !(await consent(vl, user.userId, { R, sess: v.sess }))) return hood;
    const cam = { ...t, login: vl, vsess: String(v.sess), veiled: true, name: c.label };
    if (e.video === "live") {
      let allowed = false;
      try { allowed = e.pin ? !!deps.pin(R.id, vl) : deps.exact(R.id, vl) === true; } catch (_) { /* hood */ }
      const p = allowed ? deps.vpath(R.id, vl) : null;
      if (p) return { ...cam, mode: "live", path: p, image: c.art };
    } else if (e.video === "still") {
      try {
        const s = await deps.still(R.id, vl);
        if (s && s.state === "ok" && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s.img) && s.img.length <= 8 * 1024 * 1024) {
          return { ...cam, mode: "still", image: Buffer.from(s.img.slice(s.img.indexOf(",") + 1), "base64") };
        }
      } catch (_) { /* hood */ }
    }
    return hood;
  }
  if (e.kind !== "cam" || (e.watch !== "ok" && e.watch !== "notice")) return t;
  const login = String(e.login || e.id).toLowerCase();
  if (!LOGIN.test(login)) return t;
  // 1.99ahq stage cover: the picture this person's name card shows on the page (their GTF avatar by default) - loaded for every
  // consenting named tile, so a live / still tile that ends up a card draws it too. A cover tile never gets here (coverArt above)
  // (fix 3: the 500 ms samples compare tiles only - they never wait on a picture; review fix 3 (FID-1): neither does start())
  // 1.99ahq review fix 3 (FID-1): the picture FIRST, consent after it - consent is the last thing read before a tile is drawn, so
  // someone who goes hidden / private while a slow picture loads (a snap's final frame) is never drawn by name
  const cover = covers ? await coverFor(e) : null;
  // 1.99aid (privacy controls S3): a WITHHELD cam's card (micfollow card state "withheld" - its program says so on the capture surface
  // only) while micfollow_cfg withheld_cover is on: the name and the cover, never the cam's rules (cardConsent) and never the cam (no
  // relay path, no still) - a name card. Off: the program never says "withheld"; anything else as before
  if (e.video === "card" && e.why === "withheld" && deps.withheldOn()) {
    if (!(await cardConsent(login, user.userId))) return t;
    return Object.assign(t, { login, name: String(e.name || login), mode: "card", cover, withheld: true });
  }
  if (!(await consent(login, user.userId))) return t;
  Object.assign(t, { login, name: String(e.name || login), mode: "card" });
  t.cover = cover;
  if (e.watch === "notice") return t;
  if (e.video === "live") {
    let allowed = false;
    try { allowed = e.pin ? !!deps.pin(R.id, login) : deps.exact(R.id, login) === true; } catch (_) { /* card */ }
    if (allowed) { t.mode = "live"; t.path = deps.camPath(R.id, login); }
  } else if (e.video === "still") {
    try {
      const s = await deps.still(R.id, login);
      if (s && s.state === "ok" && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s.img) && s.img.length <= 8 * 1024 * 1024) {
        t.image = Buffer.from(s.img.slice(s.img.indexOf(",") + 1), "base64"); t.mode = "still";
      }
    } catch (_) { /* name card */ }
  }
  return t;
}
async function tilesFor(p, R, user, opts) { return Promise.all(entries(p).map(e => tileFor(e, R, user, opts))); }
/** 1.99ahq review fix 3 (FID-2): a clip's card covers, loaded at its cut - the cover each named tile carried on the viewer's stage at
 *  the end (t.coverUrl, kept by the samples), read again then (stagecover.captureImage re-checks an upload's state): a picture taken
 *  down or changed during the recording is never drawn; the end state is drawn for the whole clip. All at once, each bounded by
 *  COVER_WAIT_MS. Veiled (cover) and blank tiles have no login: never a picture. Never throws. */
async function loadCovers(tiles) {
  await Promise.all(tiles.map(async t => {
    t.cover = null;
    if (!t.login || t.mode === "blank" || t.mode === "cover") return;
    try { t.cover = await coverFor({ avatar: t.coverUrl }); } catch (_) { t.cover = null; }
  }));
}
async function gate(R, user, kind, surface, { live = false, net = null } = {}) {
  if (!R || !user || !user.userId) throw refuse("Sign in first.", 401);
  if (deps.config().stagecap_mic !== true) throw refuse("disabled");
  if (surface === "home") throw refuse("home");
  const why = deps.killed(kind) || deps.roomOff(R.id) || deps.eligibility(user);
  if (why) throw refuse(why);
  // review fix: the 💎 Prime Time Plus bridge gate the cam captures obey: no shown bridge room, no capture.
  // review fix 2: the perk itself (bridgeOk, like livecam's cam captures) - bridge.isLiveShown also needs a Pepe sync within 90 s, and
  // a Pepe restart then revoked every pending preview through recheck. Pepe live (`live`) only where a capture needs him now: start,
  // each recording sample, availability and stagecap's check before it writes anything.
  if (!deps.bridgeOk(R.id) || (live && !deps.liveShown(R.id))) throw refuse("unavailable");
  if (!(await deps.full(user, R.id))) throw refuse("denied");
  const block = await deps.block(R.id, user.userId, kind === "clip" ? "clips" : "snapshots");
  if (block) throw refuse(typeof block === "string" ? block : block.error || "unavailable");
  // audiogate2: a clip is the room audio too - banned from hearing the pad, the access loss's answer (a snap is pictures only)
  if (kind === "clip" && (await deps.listenBan(R.id, user, net))) throw refuse("denied");
  if (kind === "clip" && deps.clipSwitch(R.id) !== true) throw refuse(deps.clipOffText(R.id));
}
async function availability(R, user, surface, translate) {
  if (deps.config().stagecap_mic !== true) return null;
  const view = { snap: false, clip: false, why: null };
  for (const k of ["snap", "clip"]) try { await gate(R, user, k, surface, { live: true }); view[k] = true; } catch (e) {   // review fix 2: + live
    const why = e.i18n && translate ? translate(e.i18n, e.vars) : e.message;
    view[k + "_why"] = why; if (!view.why) view.why = why;
  }
  return view;
}
async function recheck(capture, { net = null } = {}) {
  try {
    const u = await deps.account(capture.user_id), R = await deps.resolveRoom(capture.room_id);
    await gate(R, u, capture.kind === "clip" ? "clip" : "snap", "pad", { net });     // (audiogate2: + the asking request's network)
    // mic keep review: the name cards too - someone shown only by name who has gone private / hidden since the preview isn't published
    const drawn = await deps.people(capture.id), cards = await deps.cards(capture.id);
    // (1.99aid privacy controls V-1: a cam drawn under a frog name - still incognito, never published once they show by name)
    let vset = new Set();
    try { vset = new Set((await deps.veiledPeople(capture.id)).map(l => String(l).toLowerCase())); } catch (_) { vset = new Set(); }
    // (1.99aid privacy controls S3: a name card asks the name-card consent - cardConsent, today's consent while withheld_cover is off)
    for (const [login, card] of [...drawn.map(l => [l, false]), ...cards.map(l => [l, true])]) {
      const v = vset.has(String(login).toLowerCase());
      if (!(await (card && !v ? cardConsent(login, u.userId) : consent(login, u.userId, v ? { sess: null } : null)))) return MSG.revoked;
    }
    return null;
  } catch (_) { return MSG.revoked; }
}

function loopback(ip) {
  const s = String(ip || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (s === "::1" || s === "0:0:0:0:0:0:0:1") return true;
  const v4 = s.replace(/^::ffff:/, ""); return net.isIP(v4) === 4 && v4.split(".")[0] === "127";
}
function rtspBase(raw = process.env.STAGECAP_RTSP_BASE || "rtsp://127.0.0.1:8554") {
  const u = new URL(raw), host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol !== "rtsp:" || !net.isIP(host) || !loopback(host) || u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) throw refuse("failed", 500);
  return u.origin === "null" ? "rtsp://" + u.host : u.origin;
}
function password(job, p) { return crypto.createHmac("sha256", SECRET).update("stagecap-read:" + p + ":" + job.id + ":" + job.expiry).digest("hex"); }
function rtspAuth(b, p) {
  if (!b || !loopback(b.ip)) return 403;
  if (!b.user && !b.password) return 401;
  if (b.user !== "stagecap" || typeof b.password !== "string" || !/^[a-f0-9]{64}$/.test(b.password)) return 403;
  const now = deps.now();
  for (const j of JOBS.values()) if (!j.cancelled && j.reading && j.paths.has(p) && j.expiry > now && j.expiry - now <= (j.kind === "clip" ? j.secs : 6) * 1000 + 15000) {
    const expected = password(j, p);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(b.password))) return 200;
  }
  return 403;
}
function readerArgs(job, tile, file) {
  const u = new URL(rtspBase()); u.username = "stagecap"; u.password = password(job, tile.path); u.pathname = "/" + tile.path;
  const a = ["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "rtsp,tcp,rtp", "-rtsp_transport", "tcp", "-f", "rtsp", "-i", u.toString(), "-map", "0:v:0", "-an", "-map_metadata", "-1"];
  return a.concat(job.kind === "snap" ? ["-frames:v", "1", "-c:v", "png", "-f", "image2", "-y", file] : ["-c:v", "copy", "-progress", "pipe:1", "-f", "mpegts", "-y", file]);
}
function readerTimeoutMs(job) {
  // Authentication expiry also bounds already-open readers; a large measured offset may keep
  // the overall job alive longer, but never extends the camera-reading permission.
  return Math.max(1, Math.min(job.deadline + (job.kind === "snap" ? 0 : 500), job.expiry) - deps.now());
}
function spawnReader(job, tile, file) {
  const fm = deps.fm(), a = readerArgs(job, tile, file), ff = fm.bin("ffmpeg");
  const nice = process.platform === "linux" && !process.env.FEED_NO_NICE;
  const cp = spawn(nice ? "nice" : ff, nice ? ["-n", "10", ff, ...a] : a, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let err = "", progress = "", settled = false, timer, firstAt = null;
  const kill = () => { if (!settled) try { cp.kill("SIGKILL"); } catch (_) { /* already closed */ } };
  const done = new Promise(resolve => {
    cp.stderr.on("data", b => { err = sanitize(err + b.toString()).slice(-4096); });
    cp.stdout.on("data", b => {
      progress = (progress + b.toString()).slice(-8192);
      const m = /out_time_us=(\d+)/.exec(progress);
      if (firstAt == null && m && Number(m[1]) > 0) firstAt = Math.max(0, (deps.now() - job.started) / 1000 - Number(m[1]) / 1e6);
    });
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: code === 0, file, firstAt: firstAt == null ? 0 : firstAt, error: err }); };
    cp.once("error", () => finish(-1)); cp.once("close", finish);
    timer = setTimeout(kill, readerTimeoutMs(job));
  });
  return { done, kill, file, get firstAt() { return firstAt; } };
}
let snapReaders = 0;
const snapWait = [];
async function snapSlot() {
  if (snapReaders >= 4) await new Promise(r => snapWait.push(r));
  else snapReaders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = snapWait.shift();
    if (next) next(); // transfer the reserved permit; a fresh caller cannot steal it
    else snapReaders--;
  };
}
function imageRect(r) { return { x: r.x + 3, y: r.y + 3, w: Math.max(2, r.w - 6), h: Math.max(2, r.h - 37) }; }
function svg(body, width = W, height = H) { return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`); }
function svgText(x, y, value, size = 22, anchor = "middle", fill = "#edf2f7", limit = 40) { return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="sans-serif" font-size="${size}" fill="${fill}">${text(value, limit)}</text>`; }
function pinSvg(r) { return `<path d="M${r.x + 17} ${r.y + 11}h12l-2 12 5 5h-9v11l-3-11h-8l7-5z" fill="#d8e1ec"/>`; }
async function renderFrame(p, tiles, R, out, opts = {}) {
  const sharp = require("sharp"), rs = rects(p, W, H - FOOT), byId = new Map(tiles.map(t => [t.id, t]));
  const layers = [{ input: svg(`<rect width="${W}" height="${H}" fill="${DARK}"/>`), left: 0, top: 0 }];
  for (const r of rs) {
    const t = byId.get(r.id); if (!t) continue;
    const ir = imageRect(r);
    let tile = `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${DARK}"/>`, picture = null;
    if (t.image && ["still", "live", "cover"].includes(t.mode)) {
      try {
        const data = await sharp(t.image, { limitInputPixels: 30e6 }).resize(ir.w, ir.h, { fit: "contain", background: DARK }).png().toBuffer();
        picture = { input: data, left: ir.x, top: ir.y };
      } catch (_) { if (t.mode !== "cover") t.mode = "card"; }
    }
    // 1.99ahq stage cover: a name card shows the person's cover picture (as on the page) - pixel art kept crisp - else the letter
    if (t.mode === "card" && t.cover && t.cover.buf) {
      try {
        const side = Math.max(16, Math.floor(Math.min(ir.w * .8, ir.h * .8, 260)));
        const pixel = t.cover.k === "gtf" || t.cover.k === "sticker";
        // fix 3: a profile photo is cropped round, as the page draws it (.cv-photo: object-fit cover in a circle)
        const round = t.cover.k === "photo";
        let img = sharp(t.cover.buf, { limitInputPixels: 30e6, density: pixel ? 72 : 144 })
          .resize(side, side, round ? { fit: "cover", kernel: "lanczos3" } : { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: pixel ? "nearest" : "lanczos3" });
        if (round) img = sharp(await img.ensureAlpha().png().toBuffer()).composite([{ input: svg(`<circle cx="${side / 2}" cy="${side / 2}" r="${side / 2}" fill="#fff"/>`, side, side), blend: "dest-in" }]);
        const data = await img.png().toBuffer();
        picture = { input: data, left: Math.round(r.x + (r.w - side) / 2), top: Math.round(ir.y + (ir.h - side) / 2) };
      } catch (_) { t.cover = null; }
    }
    if (t.mode === "card" && !picture) {
      const initials = String(t.name).trim().split(/\s+/).map(x => Array.from(x)[0]).slice(0, 2).join("").toUpperCase();
      tile += `<circle cx="${r.x + r.w / 2}" cy="${r.y + r.h / 2 - 20}" r="${Math.min(48, r.h / 5)}" fill="#293747"/>` + svgText(r.x + r.w / 2, r.y + r.h / 2 - 10, initials, Math.min(32, r.h / 7));
    }
    layers.push({ input: svg(tile), left: 0, top: 0 });
    if (picture) layers.push(picture);
    if (t.mode !== "blank") {
      let label = `<rect x="${r.x + 3}" y="${r.y + r.h - 34}" width="${r.w - 6}" height="31" fill="#0a1018" fill-opacity=".88"/>` + svgText(r.x + 12, r.y + r.h - 12, t.name, Math.min(22, Math.max(12, r.w / 18)), "start");
      if (t.pin) label += pinSvg(r);
      if (!opts.noRing && t.newest) label += `<rect x="${r.x + 2}" y="${r.y + 2}" width="${r.w - 4}" height="${r.h - 4}" fill="none" stroke="#65dca4" stroke-width="4"/>`;
      layers.push({ input: svg(label), left: 0, top: 0 });
    }
  }
  let top = "";
  const speak = speaking(p);
  if (speak && !opts.noSpeaking) top += speakingSvg(speak, !!rs.length);
  const padTitle = Array.from(String(R.title || R.name || "")).slice(0, 40).join("");
  top += `<rect y="${H - FOOT}" width="${W}" height="${FOOT}" fill="#090f17"/>` + svgText(16, H - 10, "On the mic · " + padTitle + " · publicaccess.tv", 17, "start", "#aebdcd", 100);
  layers.push({ input: svg(top), left: 0, top: 0 });
  const image = sharp({ create: { width: W, height: H, channels: 4, background: DARK } }).composite(layers);
  if (out) return path.extname(out) === ".webp" ? image.webp({ quality: 82 }).toFile(out) : image.png().toFile(out);
  return image.png().toBuffer();
}
function speakingSvg(kind, dim) {
  return (dim ? `<rect width="${W}" height="${H - FOOT}" fill="#000" fill-opacity=".6"/>` : "") +
    `<rect x="260" y="${dim ? 20 : 290}" width="760" height="70" rx="12" fill="#172332"/>` + svgText(W / 2, dim ? 64 : 334, kind === "pepe" ? "Pepe is on the mic" : "Someone is speaking", 32);
}

/** Decode-byte ranges, not arrival estimates, determine where an MP3 chunk lands in the output. */
function mergeWindows(windows, duration) {
  const out = [];
  for (const w of windows.map(([a, b]) => [Math.max(0, a), Math.min(duration, b)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1]; if (last && w[0] <= last[1] + .001) last[1] = Math.max(last[1], w[1]); else out.push(w);
  }
  return out;
}
function shifts(offsets) {
  const vals = offsets.map(v => Number.isFinite(v) ? v / 1000 : 0);
  const audio = Math.max(0, -Math.min(0, ...vals));
  const video = vals.map(v => v + audio);
  return { audio, video, extra: Math.max(audio, ...video, 0) };
}
// mic keep review: `private_s` - the muted seconds that may hide a hidden / private speaker (Pepe's hm mark, a private holder in the
// roster history, audio that can't be placed against it). The lead-in - sound made before the first roster read, muted because the
// audio is future-only - isn't one: every clip with real MP3 latency starts with it, and nothing heard in it is anyone's. muted_s
// stays the total (the preview's audio note).
function audioPlan(chunks, packets, privateHistory, duration, audioShift = 0) {
  if (!chunks.length) return { reason: "off", muted: [], segments: [], muted_s: 0, private_s: 0 };
  if (chunks.some(c => c.hm !== 0 && c.hm !== 1)) return { reason: "outdated", muted: [], segments: [], muted_s: 0, private_s: 0 };
  const ranges = chunks.map(c => ({ ...c, begin: Infinity, end: -Infinity }));
  let time = 0;
  for (const p of packets) {
    const dt = Number(p.duration_time), pos = Number(p.pos), size = Number(p.size);
    if (!(dt > 0) || !Number.isFinite(pos) || !(size > 0)) continue;
    for (const c of ranges) if (pos < c.offset + c.bytes && pos + size > c.offset) { c.begin = Math.min(c.begin, time); c.end = Math.max(c.end, time + dt); }
    time += dt;
  }
  if (!time || ranges.some(c => !Number.isFinite(c.begin))) return { reason: "outdated", muted: [], segments: [], muted_s: 0, private_s: 0 };
  const muted = [], priv = [], segments = [];
  const mute = (w, isPrivate) => { muted.push(w); if (isPrivate) priv.push(w); };
  const firstRead = privateHistory.length ? privateHistory[0].at : -Infinity;   // no roster read at all: nothing is a lead-in
  // A chunk's arrival marks the end of that chunk, not the start. Accommodate interrupted posts
  // without pulling later sound earlier: contiguous decoded ranges share one placement segment.
  let anchor = Math.max(0, ranges[0].at - (ranges[0].end - ranges[0].begin));
  let seg = { begin: 0, end: 0, at: anchor + audioShift };
  for (const c of ranges) {
    const arrivalStart = Math.max(0, c.at - (c.end - c.begin));
    if (arrivalStart - (anchor + c.begin) > .5) { seg.end = c.begin; if (seg.end > seg.begin) segments.push(seg); anchor = arrivalStart - c.begin; seg = { begin: c.begin, end: c.end, at: arrivalStart + audioShift }; }
    seg.end = Math.max(seg.end, c.end);
    const begin = anchor + c.begin + audioShift, end = anchor + c.end + audioShift;
    if (c.hm === 1) mute([begin - .25, end + .25], true);
    const latency = c.lat && c.lat.mp3_ms;
    if (!Number.isFinite(latency)) { mute([begin, end], true); continue; }
    // Look BACK from audio arrival to the mic roster that produced it. A grab at 5 s and
    // a 1 s MP3 delay mutes sound arriving around 6 s, never sound that arrived at 4 s.
    const sourceA = arrivalStart - latency / 1000, sourceB = c.at - latency / 1000;
    let coveredUntil = sourceA;
    for (let i = 0; i < privateHistory.length; i++) {
      const h = privateHistory[i], next = privateHistory[i + 1];
      const a = h.at, b = next ? next.at : duration + 20;
      if (a <= coveredUntil && b > coveredUntil) coveredUntil = b;
      if (h.private && sourceA < b + .5 && sourceB >= a - .5) mute([begin - .5, end + .5], true);
    }
    // uncovered: made before the first roster read (the lead-in) - or, anywhere else, a stretch nobody read (private)
    if (coveredUntil < sourceB) mute([begin - .5, end + .5], !(sourceA < firstRead));
  }
  if (seg.end > seg.begin) segments.push(seg);
  const merged = mergeWindows(muted, duration), privMerged = mergeWindows(priv, duration);
  const secs = ws => ws.reduce((n, w) => n + w[1] - w[0], 0);
  return { reason: null, muted: merged, segments, muted_s: secs(merged), private_s: secs(privMerged) };
}
/** review fix: every observation from `from` (job s) on is private, and the sorted history gets that boundary too. */
function privateSince(history, from) {
  let i = history.findIndex(h => h.at >= from);
  if (i < 0) i = history.length;
  for (let k = i; k < history.length; k++) history[k].private = true;
  if (!history[i] || history[i].at > from) history.splice(i, 0, { at: from, private: true });
}
function privateSample(job) {
  // review fix 2: the lookup in flight stays on the job (its promise, and the sample's time in privacyAt), so a cut can wait for
  // the private look-back it carries (settlePrivacy) instead of planning the audio without it
  if (job.privacyPending) return job.privacyPending;
  const p = privateSampleNow(job).finally(() => { if (job.privacyPending === p) job.privacyPending = null; });
  job.privacyPending = p;
  return p;
}
/** review fix 2: before the audio plan, a sample whose profile lookup is still pending - its private holder's look-back (from the
 *  hold's since) lands only when it resolves. Waited up to deps.privacyWaitMs; still pending, it counts as a private holder from
 *  MIC_LAG before that sample (privateSample's unknown-since rule). -> true when nothing was left pending */
async function settlePrivacy(job) {
  const p = job.privacyPending;
  if (!p) return true;
  let timer;
  const settled = await Promise.race([p.then(() => true, () => true), new Promise(r => { timer = setTimeout(() => r(false), Math.max(0, Number(deps.privacyWaitMs) || 0)); })]);
  clearTimeout(timer);
  if (!settled) privateSince(job.privateHistory, Math.max(0, job.privacyAt - MIC_LAG));
  return settled;
}
async function privateSampleNow(job) {
  const at = (deps.now() - job.started) / 1000;
  job.privacyAt = at;
  const previous = job.privateHistory.at(-1);
  if (previous && at - previous.at > 1) job.privateHistory.push({ at: previous.at + .5, private: true });
  // Unknown until the lookup completes. A cut that starts while this promise is pending must
  // not extend the last known-public roster over sound we have not checked yet.
  const observation = { at, private: true };
  job.privateHistory.push(observation);
  let priv = true, from = Math.max(0, at - MIC_LAG);
  try {
    const mic = deps.mic(job.R.id);
    if (job.kind === "clip") noteVoices(job, mic);
    if (Array.isArray(mic)) {
      const holders = mic.filter(x => x && !x.anon && LOGIN.test(String(x.login || "")));
      const found = await deps.privateLogins(holders.map(x => String(x.login).toLowerCase()));
      priv = found.size > 0;
      // review fix: a private holder's turn starts at their hold's `since` (epoch ms -> job time, never before the job), not
      // at this sample: Pepe's mic list reaches the site up to MIC_LAG after the grab. Unknown since: MIC_LAG back.
      const starts = holders.filter(x => found.has(String(x.login).toLowerCase())).map(x => {
        const s = Number(x.since);
        return Number.isFinite(s) && s > 0 ? Math.max(0, (s - job.started) / 1000) : Math.max(0, at - MIC_LAG);
      });
      if (starts.length) from = Math.min(at, ...starts);
    }
  } catch (_) { if (job.kind === "clip") job.unseen = true; /* unavailable mic list is private */ }
  observation.private = priv;
  if (priv && from < at) privateSince(job.privateHistory, from);
  // The roster was observed before the lookup, not after it. If the lookup consumed more than
  // a polling interval, the unobserved remainder is private until the next successful sample.
  if ((deps.now() - job.started) / 1000 - at > .5) job.privateHistory.push({ at: at + .5, private: true });
}
/** mic keep: a clip's room audio carries the voice of everyone holding the mic. A holder the clip doesn't show openly right now -
 *  anonymous, unproven, an account key, a new holder the fixed tiles never draw, one whose tile stopped - or a mic list that can't be
 *  read marks the clip as not taken in the open (job.unseen; never who). Pepe himself (self) and bots aren't people.
 *  Review: unproven = no `proven: true` from Pepe's identity resolver - such a 0x16 name is never the tile that shows that login
 *  (micfollow stages proven holders only), even when the names match. */
function noteVoices(job, mic) {
  if (!Array.isArray(mic)) { job.unseen = true; return; }
  const shown = new Set((job.tiles || []).filter(t => t.login && t.stop == null && t.mode !== "blank" && t.mode !== "cover").map(t => t.login));
  for (const x of mic) {
    if (!x || x.self || x.bot) continue;
    const l = String(x.login || "").toLowerCase();
    if (x.anon || x.proven !== true || !LOGIN.test(l) || !shown.has(l)) { job.unseen = true; return; }
  }
}
/**
 * mic keep review: one last mic-list read MIC_LAG after a clip's end - Pepe's list reaches the site up to MIC_LAG after a grab, so the
 * samples never saw a hold that began in the clip's last ~2 s, though its voice is in the clip. A hold that began before the end is
 * checked like any sample's: a private holder is muted from their since (the 24 h story's clip too), and a voice the tiles don't show
 * marks the clip as not taken in the open (noteVoices). A hold that began after the end isn't in the clip; one without a since counts.
 * An unreadable list (or private lookup) is private for the last MIC_LAG and unseen. Waits at most deps.lastRosterWaitMs.
 * (Sound from a hold that ended just before the clip started is in its lead-in, which audioPlan always mutes.)
 */
async function lastRoster(job, duration) {
  const end = job.started + duration * 1000;
  const wait = Math.min(Math.max(0, Number(deps.lastRosterWaitMs) || 0), end + MIC_LAG * 1000 - deps.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  const unknown = () => { job.unseen = true; privateSince(job.privateHistory, Math.max(0, duration - MIC_LAG)); };
  let mic;
  try { mic = deps.mic(job.R.id); } catch (_) { mic = null; }
  if (!Array.isArray(mic)) return unknown();
  const held = mic.filter(x => x && !(Number(x.since) > end));
  noteVoices(job, held);
  const holders = held.filter(x => !x.anon && LOGIN.test(String(x.login || "")));
  let found;
  try { found = await deps.privateLogins(holders.map(x => String(x.login).toLowerCase())); } catch (_) { return unknown(); }
  const starts = holders.filter(x => found.has(String(x.login).toLowerCase())).map(x => {
    const s = Number(x.since);
    return Number.isFinite(s) && s > 0 ? Math.max(0, (s - job.started) / 1000) : Math.max(0, duration - MIC_LAG);
  });
  if (starts.length) privateSince(job.privateHistory, Math.min(...starts));
}
function stopTile(job, t, at) {
  if (t.stop != null) return; t.stop = Math.max(0, at); job.paths.delete(t.path);
  if (t.reader) t.reader.kill();
}
async function sample(job) {
  if (job.sampling || job.cancelled || !job.reading) return;
  job.sampling = true;
  try {
    const at = (deps.now() - job.started) / 1000;
    privateSample(job).catch(() => {});
    const user = await deps.account(job.user.userId);
    await gate(job.R, user, job.kind, job.surface, { live: true, net: job.net });   // review fix 2: a recording needs Pepe live (audiogate2: + its network)
    const p = await programFor(job.R, user);
    if (!usable(p)) throw refuse("empty", 409);
    const current = new Map((await tilesFor(p, job.R, user, { covers: false })).map(t => [t.id, t]));   // (fix 3: no picture waits)
    for (const t of job.tiles) {
      const next = current.get(t.id);
      if (t.stop == null && (!next || next.mode === "blank" || next.mode !== t.mode || next.login !== t.login || next.path !== t.path || next.source.watch !== t.source.watch)) {
        stopTile(job, t, at);
        // mic keep: blanked now (or turned into a cover), or gone from the program while their consent fails (micfollow cuts a person who
        // goes private / hidden / incognito or withdraws) -> not taken in the open. Leaving the mic with consent intact is fine.
        // (1.99aid privacy controls S3: a name card that left - the name-card consent, cardConsent: a withheld cam's card leaving the mic
        // is "leaving with consent intact")
        if (next ? next.mode === "blank" || next.mode === "cover"
          : !(t.login && (await (t.mode === "card" && !t.vsess ? cardConsent(t.login, user.userId) : consent(t.login, user.userId, t.vsess ? { R: job.R, sess: t.vsess } : null))))) job.veiled = true;
      }
      if (t.stop == null && !!next.newest !== t.lastNewest) { t.rings.push({ at, on: !!next.newest }); t.lastNewest = !!next.newest; }
      // 1.99ahq review fix 3 (FID-2): the cover this tile carries on the viewer's stage now (no picture loaded here - the cut loads it)
      if (t.stop == null && t.login) t.coverUrl = next.source.avatar;
    }
    const s = speaking(p);
    if (s !== job.lastSpeaking) { job.speaking.push({ at, kind: s }); job.lastSpeaking = s; }
    if (!job.tiles.some(t => t.stop == null && t.mode !== "blank") && !s) job.finishEarly(at);
  } catch (_) { job.finishEarly((deps.now() - job.started) / 1000); }
  finally { job.sampling = false; }
}
function finishReaders(job) { job.reading = false; job.paths.clear(); for (const t of job.tiles) if (t.reader) t.reader.kill(); if (job.untap) { job.untap(); job.untap = null; } clearInterval(job.timer); }
function removeFile(p) { try { fs.unlinkSync(p); } catch (_) { /* absent */ } }
function cleanJob(job) {
  finishReaders(job);
  // Only files created directly in this job's own, validated directory are removed.
  try { for (const name of fs.readdirSync(job.dir)) { const p = path.join(job.dir, name); if (fs.lstatSync(p).isFile()) removeFile(p); } fs.rmdirSync(job.dir); } catch (_) { /* retry on startup */ }
}
function cancel(id) {
  const j = JOBS.get(String(id)); if (!j) return false;
  j.cancelled = true; finishReaders(j); j.finishEarly(0); removeFile(j.out); return true;
}
async function init(tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const name of fs.readdirSync(tmpDir)) if (/^mic-c[a-f0-9]{20}$/.test(name)) {
    const dir = path.join(path.resolve(tmpDir), name);
    if (fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink()) cleanJob({ dir, tiles: [], paths: new Set() });
  }
}
async function snap(job) {
  job.finishEarly = at => { for (const t of job.tiles) stopTile(job, t, at); finishReaders(job); };
  job.timer = setInterval(() => { sample(job).catch(() => {}); }, 500);
  await Promise.all(job.tiles.filter(t => t.mode === "live").map(async (t, i) => {
    const release = await snapSlot();
    try {
      if (job.cancelled || t.stop != null || deps.now() >= job.deadline) return;
      const file = path.join(job.dir, "frame-" + i + ".png");
      t.reader = (deps.reader || spawnReader)(job, t, file);
      const result = await t.reader.done;
      if (result.ok && !job.cancelled && t.stop == null) try { t.image = fs.readFileSync(file); } catch (_) { /* card */ }
    } finally { release(); }
  }));
  finishReaders(job);
  if (job.cancelled) throw refuse("failed", 409);
  const user = await deps.account(job.user.userId); await gate(job.R, user, "snap", job.surface);
  const p = await programFor(job.R, user); if (!usable(p)) throw refuse("empty", 409);
  const final = await tilesFor(p, job.R, user), old = new Map(job.tiles.map(t => [t.id, t]));
  for (const t of final) if (t.mode === "live") {
    const prior = old.get(t.id);
    if (prior && prior.stop == null && prior.mode === "live" && prior.path === t.path && prior.source.watch === t.source.watch && prior.image) t.image = prior.image;
    else t.mode = t.veiled ? "cover" : "card";      // (1.99aid privacy controls V-1: a veiled cam without its frame: the hood)
  }
  await renderFrame(p, final, job.R, job.out);
  const people = [...new Set(final.filter(t => t.login && !t.veiled && t.image && (t.mode === "live" || t.mode === "still")).map(t => t.login))];
  // mic keep: a snap is its final frame - the logins drawn only as a name card (consent passed: tileFor sets a login only then; a
  // picture that failed to render became a card), and whether everyone in that frame was shown openly
  const cards = [...new Set(final.filter(t => t.login && !t.veiled && t.mode !== "blank" && !people.includes(t.login)).map(t => t.login))];
  // (1.99aid privacy controls V-1: a cam drawn under a frog name - server-only, with its session. Review fixes 2 - Q4-A (owner Q4: every
  // cam feature works for an incognito cam, only the name changes): a frog-name cam DRAWN under its frog name is shown in the open
  // like a named cam - storykeep keeps it as a "vcam", never naming its person; a veiled tile NOT drawn (its hood) still veils it)
  const vpeople = vpeopleOf(final.filter(t => t.veiled && t.login && t.image && (t.mode === "live" || t.mode === "still")));
  const vdrawn = new Set(vpeople.map(v => v.login));
  const veiled = final.some(t => t.mode === "cover" || t.mode === "blank" || (t.veiled && !vdrawn.has(t.login))) || speaking(p) === "someone";
  return { secs: 0, bytes: fs.statSync(job.out).size, people, cards, veiled, audio: null, ...(vpeople.length ? { vpeople } : {}) };
}

/** 1.99aid (privacy controls V-1): the veiled cams a capture drew -> [{login, sess}] (one per login). */
function vpeopleOf(tiles) {
  const out = [], seen = new Set();
  for (const t of tiles) if (t && t.login && !seen.has(t.login)) { seen.add(t.login); out.push({ login: t.login, sess: String(t.vsess || "") }); }
  return out;
}
function intervals(changes, end, key = "on") {
  const out = []; changes.forEach((c, i) => { const b = Math.min(end, changes[i + 1] ? changes[i + 1].at : end); if (c[key] && b > c.at) out.push([c.at, b, c[key]]); }); return out;
}
const num = n => Math.max(0, Number(n) || 0).toFixed(4);
/** One final filter graph. File-only inputs and forced demuxers; no user strings in expressions. */
function composeArgs({ base, tiles, rectangles, duration, audioFile, audio, speakingFiles = {}, speakingChanges = [], out }) {
  const args = ["-hide_banner", "-nostdin", "-v", "error", "-filter_complex_threads", "1", "-protocol_whitelist", "file,pipe", "-loop", "1", "-framerate", "15", "-f", "image2", "-i", base];
  const f = ["[0:v]format=yuv420p,setpts=PTS-STARTPTS[v0]"];
  let index = 1, v = 0;
  // Paint each entire tile in CSS z-order. In PiP, a stopped main may be blanked without
  // painting over the still-active inset that comes afterwards.
  for (const r of rectangles) {
    const t = tiles.find(x => x.id === r.id); if (!t) continue;
    if (t.staticFile) {
      args.push("-protocol_whitelist", "file,pipe", "-loop", "1", "-framerate", "15", "-f", "image2", "-i", t.staticFile);
      f.push(`[v${v}][${index}:v]overlay=${r.x}:${r.y}[v${++v}]`); index++;
    }
    if (t.file) {
      const ir = imageRect(r), w = Math.floor(ir.w / 2) * 2, h = Math.floor(ir.h / 2) * 2;
      args.push("-protocol_whitelist", "file", "-f", "mpegts", "-i", t.file);
      const start = Math.max(0, t.firstAt || 0) + (t.shift || 0), end = Math.min(duration, t.stop == null ? duration : t.stop);
      f.push(`[${index}:v]setpts=PTS-STARTPTS+${num(start)}/TB,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x10151d,setsar=1[t${index}]`);
      f.push(`[v${v}][t${index}]overlay=${ir.x}:${ir.y}:eof_action=pass:enable='between(t,${num(start)},${num(end)})'[v${++v}]`); index++;
    }
    if (t.mode === "blank") continue;
    for (const [a, b] of intervals(t.rings || [], Math.min(duration, t.stop == null ? duration : t.stop))) {
      f.push(`[v${v}]drawbox=x=${r.x + 2}:y=${r.y + 2}:w=${r.w - 4}:h=${r.h - 4}:color=0x65dca4:t=4:enable='between(t,${num(a)},${num(b)})'[v${++v}]`);
    }
    if (t.stop != null && t.stop < duration) f.push(`[v${v}]drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=0x10151d:t=fill:enable='gte(t,${num(t.stop)})'[v${++v}]`);
  }
  for (const kind of ["someone", "pepe"]) {
    const wins = intervals(speakingChanges, duration, "kind").filter(x => x[2] === kind); if (!wins.length || !speakingFiles[kind]) continue;
    args.push("-protocol_whitelist", "file,pipe", "-loop", "1", "-framerate", "15", "-f", "image2", "-i", speakingFiles[kind]);
    f.push(`[v${v}][${index}:v]overlay=0:0:enable='${wins.map(([a, b]) => `between(t,${num(a)},${num(b)})`).join("+")}'[v${++v}]`); index++;
  }
  let hasAudio = !!(audioFile && audio && !audio.reason && audio.segments.length);
  if (hasAudio) {
    args.push("-protocol_whitelist", "file", "-f", "mp3", "-i", audioFile);
    const n = audio.segments.length;
    f.push(`[${index}:a]asplit=${n}${audio.segments.map((_, i) => `[as${i}]`).join("")}`);
    // review fix: the VPS's ffmpeg 4.2 has neither adelay's all= (4.3+) nor amix's normalize= (4.4+). Delay both MP3
    // channels explicitly and pad every input to the clip's length: amix then scales by a constant 1/N (no input ever
    // drops out), and volume=N restores the plain sum.
    audio.segments.forEach((s, i) => {
      const d = Math.round(s.at * 1000);
      f.push(`[as${i}]atrim=start=${num(s.begin)}:end=${num(s.end)},asetpts=PTS-STARTPTS,adelay=${d}|${d},apad,atrim=end=${num(duration)}[ad${i}]`);
    });
    // review fix 2: volume's enable is tested once per frame, at its start. After the first segment amix passes on apad's
    // 4096-sample packets, so a mute began up to ~85 ms late (186 ms at 22.05 kHz); 256-sample frames (asetnsamples, 4.2 has
    // it; p=0: no padding) mute within ~5 ms. It only re-cuts the frames - the levels are unchanged.
    f.push(audio.segments.map((_, i) => `[ad${i}]`).join("") + `amix=inputs=${n},volume=${n},apad,atrim=duration=${num(duration)}` +
      (audio.muted.length ? `,asetnsamples=n=256:p=0,volume=0:enable='${audio.muted.map(([a, b]) => `between(t,${num(a)},${num(b)})`).join("+")}'` : "") + "[audio]");
  }
  args.push("-filter_complex", f.join(";"), "-map", `[v${v}]`);
  if (hasAudio) args.push("-map", "[audio]", "-c:a", "aac", "-b:a", "128k", "-ac", "2"); else args.push("-an");
  return args.concat(["-t", num(duration), "-r", "15", "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-f", "mp4", "-y", out]);
}
async function clip(job, hooks) {
  const sharp = require("sharp"), fm = deps.fm(), base = path.join(job.dir, "base.png"), audioFile = path.join(job.dir, "audio.mp3");
  const shiftsByTile = job.shifts;
  job.deadline = job.started + (job.secs + shiftsByTile.extra + 1) * 1000;
  let vi = 0;
  for (const t of job.tiles) if (t.mode === "live") { t.shift = shiftsByTile.video[vi++]; t.reader = (deps.reader || spawnReader)(job, t, path.join(job.dir, "video-" + vi + ".ts")); }
  let offset = 0, audioEnded = false;
  const chunks = [];
  const tap = (buf, meta) => {
    if (audioEnded || !job.reading || job.cancelled || !Buffer.isBuffer(buf) || offset + buf.length > 8 * 1024 * 1024) return;
    try {
      fs.appendFileSync(audioFile, buf);
      chunks.push({ offset, bytes: buf.length, hm: meta && meta.hm, lat: meta && meta.lat ? { ...meta.lat } : null, at: (deps.now() - job.started) / 1000 }); offset += buf.length;
    } catch (_) { audioEnded = true; chunks.push({ hm: null }); }
  };
  tap.end = () => { audioEnded = true; };
  job.untap = deps.audioTap(job.R.id, tap, job.user, { net: job.net || null });   // (audiogate2: a network ban ends the tap too)
  privateSample(job).catch(() => {});
  const elapsed = await new Promise(resolve => {
    let finished = false;
    const stop = value => { if (finished) return; finished = true; clearTimeout(job.endTimer); resolve(value); };
    job.finishEarly = stop;
    job.endTimer = setTimeout(() => stop(job.secs), Math.max(0, job.deadline - deps.now()));
    job.timer = setInterval(() => { sample(job).catch(() => {}); }, 500);
    if (job.cancelled) stop(0);
  });
  finishReaders(job);
  const results = await Promise.all(job.tiles.filter(t => t.reader).map(async t => ({ t, result: await t.reader.done })));
  if (job.cancelled) throw refuse("failed", 409);
  const duration = Math.min(job.secs, elapsed);
  if (duration < CLIP_MIN) throw refuse("short", 409);
  // 1.99ahq review fix 3 (FID-2): the card covers as the recording ENDS (never the ones at its start) - loaded alongside the last
  // roster read, before the feed queue's slot is taken (a slow picture never holds the queue)
  const covers = loadCovers(job.tiles);
  // mic keep review: the holds the samples were too early to see (the mic list's MIC_LAG) - before the audio is planned
  await lastRoster(job, duration);
  if (job.cancelled) throw refuse("failed", 409);
  // review fix 2: no sample starts after finishReaders; the last one's lookup may still be in flight with its private look-back
  await settlePrivacy(job);
  await covers;
  if (hooks.cutting) await hooks.cutting();
  const release = await fm.slot();
  try {
    if (job.cancelled) throw refuse("failed", 409);
    for (const { t, result } of results) {
      try { const p = await fm.probe(result.file, "mpegts"); if (p.video && p.secs > 0) { t.file = result.file; t.firstAt = result.firstAt || 0; } } catch (_) { /* unreadable relay becomes a name card */ }
      if (!t.file && t.stop == null) t.mode = "card";
    }
    await renderFrame(job.program, job.tiles, job.R, base, { noRing: true, noSpeaking: true });
    if (job.program.layout === "pip" && !job.program.dyn) for (const r of rects(job.program, W, H - FOOT)) {
      const t = job.tiles.find(x => x.id === r.id); if (!t) continue;
      t.staticFile = path.join(job.dir, "static-" + job.tiles.indexOf(t) + ".png");
      await sharp(base).extract({ left: r.x, top: r.y, width: r.w, height: r.h }).png().toFile(t.staticFile);
    }
    const speakingFiles = {};
    for (const kind of ["someone", "pepe"]) if (job.speaking.some(c => c.kind === kind)) {
      const f = path.join(job.dir, "speaking-" + kind + ".png"); await sharp(svg(speakingSvg(kind, !!job.tiles.length))).png().toFile(f); speakingFiles[kind] = f;
    }
    let packets = [];
    if (chunks.length && chunks.every(c => c.hm === 0 || c.hm === 1)) try {
      const data = await fm.run(fm.bin("ffprobe"), ["-v", "error", "-protocol_whitelist", "file", "-f", "mp3", "-show_packets", "-show_entries", "packet=pos,size,duration_time", "-of", "json", audioFile], { timeoutMs: 10000, maxOut: 2 * 1024 * 1024 });
      packets = JSON.parse(data.out || "{}").packets || [];
    } catch (_) { /* audioPlan drops undecodable/unmapped audio */ }
    const audio = audioPlan(chunks, packets, job.privateHistory, duration, shiftsByTile.audio);
    fs.writeFileSync(path.join(job.dir, "audio-timeline.json"), JSON.stringify(chunks));
    await fm.run(fm.bin("ffmpeg"), composeArgs({ base, tiles: job.tiles, rectangles: rects(job.program, W, H - FOOT), duration, audioFile, audio, speakingFiles, speakingChanges: job.speaking, out: job.out }), { timeoutMs: 90000 });
    if (job.cancelled) throw refuse("failed", 409);
    const drawn = (t) => t.login && (t.file || (t.image && t.mode === "still")) &&
      Math.min(duration, t.stop == null ? duration : t.stop) > (t.file ? (t.firstAt || 0) + (t.shift || 0) : 0);
    const people = [...new Set(job.tiles.filter(t => !t.veiled && drawn(t)).map(t => t.login))];
    const vpeople = vpeopleOf(job.tiles.filter(t => t.veiled && drawn(t)));   // (1.99aid privacy controls V-1)
    // mic keep: every other consenting tile shows its name (a card, or a live tile's label before its video) - recorded as a card. Not
    // in the open: a cover / blank tile, a tile stopped for privacy (sample), a "Someone is speaking" card, and - only while the clip
    // carries room audio (composeArgs' hasAudio) - a muted stretch or a voice the tiles don't show (noteVoices). Audio dropped whole
    // ("off" / "outdated": no voice at all in the clip) adds nothing private, so such a clip is judged on its pictures alone.
    // Review: "a muted stretch" = one that may hide a hidden / private speaker (audioPlan's private_s), not the lead-in every clip has.
    const cards = [...new Set(job.tiles.filter(t => t.login && !t.veiled && t.mode !== "blank" && !people.includes(t.login)).map(t => t.login))];
    const heard = !audio.reason && audio.segments.length > 0;
    // (review fixes 2 - Q4-A: a frog-name cam drawn under its frog name is in the open, as in a snap; one never drawn veils the clip)
    const vdrawn = new Set(vpeople.map(v => v.login));
    const veiled = !!job.veiled || job.tiles.some(t => t.mode === "cover" || t.mode === "blank" || (t.veiled && !(t.login && vdrawn.has(t.login) && drawn(t)))) ||
      job.speaking.some(c => c.kind === "someone") ||
      (heard && (audio.private_s > 0 || !!job.unseen));
    return { secs: duration, bytes: fs.statSync(job.out).size, people, cards, veiled, audio: { reason: audio.reason, muted_s: audio.muted_s }, ...(vpeople.length ? { vpeople } : {}) };
  } finally { release(); }
}
async function start(opts, hooks = {}) {
  const { R, user } = opts, kind = opts.kind === "clip" ? "clip" : "snap", secs = [10, 20, 30].includes(Number(opts.secs)) ? Number(opts.secs) : 20;
  await gate(R, user, kind, opts.surface, { live: true, net: opts.net });   // review fix 2: a capture starts only while Pepe is live
  const program = await programFor(R, user); if (!usable(program)) throw refuse("empty", 409);
  // 1.99ahq review fix 3 (FID-1): no picture here - a slow photo never delays the recording or opens a cam reader after a consent read
  // it outlasted (a snap loads its covers with its final frame, a clip at its cut: loadCovers)
  const tiles = await tilesFor(program, R, user, { covers: false }), now = deps.now();
  const offsets = shifts(tiles.filter(t => t.mode === "live").map(t => { try { return deps.offset(R.id, t.path); } catch (_) { return null; } }));
  if (!CID.test(opts.id)) throw refuse("failed", 500);
  const active = [...JOBS.values()];
  if (active.filter(j => j.kind === kind).length >= 2) throw refuse("busy", 429);
  if (kind === "clip") {
    const existing = active.find(j => j.kind === "clip" && j.R.id === R.id);
    if (existing) throw refuse("recording", 429, { secs: Math.max(1, Math.ceil((existing.deadline - now) / 1000)) });
  } else if (SNAP_AT.has(R.id) && now - SNAP_AT.get(R.id) < 3000) throw refuse("snap_wait", 429);
  const dir = path.join(path.resolve(opts.tmpDir), "mic-" + opts.id);
  if (fs.existsSync(dir)) throw refuse("failed", 409);
  const job = { ...opts, id: opts.id, R, user, kind, secs, program, tiles, dir, shifts: offsets, started: now, deadline: now + (kind === "snap" ? 6 : secs + offsets.extra + 1) * 1000,
    expiry: now + (kind === "snap" ? 21 : secs + 15) * 1000, paths: new Set(tiles.filter(t => t.path).map(t => t.path)), reading: true, cancelled: false,
    privateHistory: [], speaking: [{ at: 0, kind: speaking(program) }], lastSpeaking: speaking(program), finishEarly: () => {} };
  tiles.forEach(t => { t.stop = null; t.rings = [{ at: 0, on: t.newest }]; t.lastNewest = t.newest; t.coverUrl = t.login ? t.source.avatar : null; });
  JOBS.set(job.id, job); if (kind === "snap") SNAP_AT.set(R.id, now);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { JOBS.delete(job.id); throw refuse("failed", 500); }
  const done = Promise.resolve().then(() => kind === "snap" ? snap(job) : clip(job, hooks)).then(async info => {
    if (job.cancelled) throw refuse("failed", 409);
    const current = await deps.account(user.userId);
    await gate(R, current, kind, job.surface, { net: job.net });
    for (const login of info.people) if (!(await consent(login, current.userId))) throw refuse("revoked");
    for (const l of info.people) await deps.note(kind, R.id, l, user.userId);
    return info;
  }).catch(e => { removeFile(job.out); if (e.refuse) throw e; const err = refuse("failed", 500); err.cause = sanitize(e.message); throw err; })
    .finally(() => { cleanJob(job); clearTimeout(job.endTimer); JOBS.delete(job.id); });
  return { ready_by: job.deadline, done, cancel: () => cancel(job.id) };
}
module.exports = { configure, init, start, gate, cancel, stop: cancel, availability, recheck, programFor, rtspAuth,
  rects, coverArt, renderFrame, audioPlan, shifts, composeArgs, sanitize,
  slotCells, CELLS, COLS,                     // 1.99ahp stable slots: the cells of a stable program (stage-mic.js has the same)
  consent,                                    // mic keep: storykeep's per-person recheck at save / post (the engine's own rule)
  cardConsent,                                // 1.99aid (privacy controls S3): ...a name card's (role "card") - no cam rules while withheld_cover is on
  privateLayoutStrict,                        // mic keep review: storykeep's strict profile read (an unreadable layout throws)
  _test: { defaults: DEFAULT_DEPS, entries, tileFor, tilesFor, consent, cardConsent, gate, loopback, rtspBase, readerArgs, readerTimeoutMs, spawnReader, snapSlot, password, sample, privateSample, privateLoginsStrict, privateLayoutStrict, noteVoices, lastRoster, jobs: JOBS, snapAt: SNAP_AT, text, intervals, mergeWindows, MSG, W, H } };
