// veil.js - wave 2 WP-2 (incognito / mic-stage spec A.3-A.5, B.2, B.3, C, D; owner answers section M): the website side of the
// PRIVACY WIRE v2 - what bridge.js does with Pepe's full form (privwire.js is the switch; the route lives in bridge.js).
//
// The rule (A.4): a veiled person's REAL identity and a hidden speaker's words never go into a stored item, a stored snapshot or
// any JSON a reader serialises. A veiled live item / roster entry is page-safe:
//   u = {anon: true, display: "someone", veil: "incognito" | "hidden", alias?, hood?, id?}
// - alias / hood = the frog name of the person's chat session in this pad (frognames.js: per pad, per appearance, unlinkable);
//   absent when C.2 allows no name (seen named < 15 min ago), for an unproven mic holder (B.2) and for the release of a hold that
//   began named (B.2) - those show "someone";
// - id = an opaque, stable id of that session in this pad (HMAC(ALIAS_SECRET, room, session), cut short) - never a login, never
//   the incog_alias row id, never a hold id; only with an alias (hand-off 15's C2 and WP-4's covers match entries by it);
// - text = Pepe's redacted text (incognito: "who, not what"); a hidden line has NO text, only mask "s" | "m" | "l" (D.2);
// - ah / ahs = the hidden-set hashes, server-only like Pepe's anonymised lines (chatlogview.dress is a whitelist);
// - hold / at = the mic hold id and when a 🎙 line was said (B.3).
// The real identity hangs on the item as NON-ENUMERABLE properties (_vz {login, display, kind, h, hs, sess}, _vw = hidden words),
// so JSON.stringify can never emit it - and is stored only in side tables keyed by the row (bridge_veil for the live ring,
// bridge_rooms_veil for snapshots, chat_log_veil for the archive) that no older build reads. Invariant: EVERY veiled entry in
// R.members, R.mic and R.feed keeps anon: true - the ~10 readers of R.members / R.mic (micfollow, livecam, aigen, camclip,
// bridge-relay, stagemiccap, roomrtc, padmod, roomactivity, the summary) all skip anon entries, so a veiled person is never staged,
// never cam-opened, never named by any of them (test/veil-storage.test.js).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const KINDS = new Set(["incognito", "hidden"]);
const HASH20 = /^[0-9a-f]{20}$/;
const HOLD_RE = /^hd-[0-9a-f]{8,32}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const ACCT_RE = /^u:([A-Za-z0-9-]{6,64})$/;
const HS_MAX = 32;
const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const cpStr = (v, n) => {
  const s = String(v == null ? "" : v).replace(CTRL, " ").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join("").replace(/[\uD800-\uDBFF]$/, "");
};
const plain = (v, n) => cpStr(String(v == null ? "" : v).replace(/<[^>]*>/g, ""), n);
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();

/** Define a non-enumerable, rewritable property (never serialised, never copied by Object.assign / spread). */
function hide(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: false, writable: true, configurable: true });
  return obj;
}
/** D.2: the bar's length - code points of the trimmed words (JS spread = Python len): s <= 24, m 25-100, l > 100. */
function bucket(words) {
  const n = [...String(words == null ? "" : words).trim()].length;
  return n <= 24 ? "s" : n <= 100 ? "m" : "l";
}
// 1.99aht transcripts bar (owner 2026-11-02: "If someone has !transcripts off, it should still show in the chat but blocked out like with
// bridge hide. Admins should be able to see through this like the other privacy toggles."): a 🎙 line of someone with !transcripts off
// comes with priv.tx: true and their words in priv.words (never text) and is stored and shown EXACTLY like a hidden speaker's 🎙 line -
// u.veil "hidden", a bar, _vz.kind "hidden" (the side tables, the reveal, the evidence clip, the archive, retention and forget-me all
// treat it as one) - plus `tm: 1` on the item (server-only: dress is a whitelist) and _vz.tx, so the see-through log says which toggle
// was seen through (seethrough.js scope tx_line) and the sticky !transcripts off set never leaves the bar out (chatlogview.privacyV2).
// priv.kind says how the speaker's IDENTITY shows: "tx" = a named speaker (no frog-name session is opened for them), "incognito" = their
// incognito frog name (_vz.lv: the frog-name session keeps its incognito level), "hidden" = one bar, as ever.
// Only Pepe's 🎙 lines carry it (a message, mic line, join or leave with priv.tx is malformed: dropped).
// 1.99aht S1 (owner Q5, spec 2.3 "Transcripts off": transcripts off covers the WORDS only): the item also keeps that level as `tl`
// ("tx" | "incognito" | "hidden" - server-only like tm, and archived with the row), and the page shows the bar under the person's NAME
// ("tx"), their frog name ("incognito") with a "transcript hidden" tag, or as one hidden bar ("hidden") - chatlogview.barLook / dress.
// Stored and revealed exactly as before (the side tables, the reveal, the evidence clip, the archive, retention and forget-me).
const TX_KINDS = new Set(["incognito", "hidden", "tx"]);
/** Pepe's priv block -> {kind, h, hs[], at (ms) | null, words, tx} | null (none, or anything malformed: then the event isn't v2-veiled). */
function parsePriv(d) {
  const p = d && d.priv && typeof d.priv === "object" ? d.priv : null;
  if (!p || typeof p.h !== "string" || !HASH20.test(p.h)) return null;
  if (p.tx !== undefined && p.tx !== true) return null;
  const tx = p.tx === true;
  if (!(tx ? TX_KINDS : KINDS).has(p.kind)) return null;
  const hs = [];
  if (Array.isArray(p.hs)) {
    for (const x of p.hs) {
      if (typeof x !== "string" || !HASH20.test(x) || x === p.h || hs.includes(x)) continue;
      if (hs.length >= HS_MAX) return null;                 // more than we keep: not shown (fails closed, as bridge.anonMore)
      hs.push(x);
    }
  }
  const at = Number(p.at);
  return { kind: p.kind, h: p.h, hs, at: Number.isFinite(at) && at > 0 ? Math.round(at * 1000) : null,
           words: (p.kind === "hidden" || tx) && typeof p.words === "string" ? cpStr(p.words, 490) : "", tx };
}
/** The real person of a v2 UserRef: {login, display, acct} | null. Accounts ("u:<id>") only where a web line may carry one. */
function realUser(u, allowAcct = false) {
  if (!u || typeof u !== "object" || u.anonymous) return null;
  const login = String(u.login || u.id || "").trim().slice(0, 70);
  if (allowAcct && ACCT_RE.test(login)) return { login, display: plain(u.display, 40) || "a PATV member", acct: true };
  if (!LOGIN_RE.test(login)) return null;
  return { login, display: plain(u.display, 40) || login };
}
const holdOf = (v) => (typeof v === "string" && HOLD_RE.test(v) ? v : null);
/** Pepe's hidden-set hash of a login / account key (chatlog.hash - sha256("pepe-hidden:" + key), trimmed, lower case, 20 hex). */
const hiddenHash = (k) => crypto.createHash("sha256").update("pepe-hidden:" + lower(k), "utf8").digest("hex").slice(0, 20);
/** Review fix (A-compat-2): is this real person one of the hashes the priv block names (h, or one of hs)? A UserRef whose login
 *  hashes to neither is someone else (a resolved login beside a matched display name, two members sharing it) - never stored as the
 *  identity behind a frog name or a bar (a reveal, a self view, a forget-me and an export would all point at the wrong person). */
const owns = (real, p) => { const h = hiddenHash(real.login); return h === p.h || p.hs.includes(h); };
/** Is a priv block present at all (any value but undefined / null)? One that is present but doesn't parse fails CLOSED. */
const hasPriv = (o) => !!o && typeof o === "object" && o.priv !== undefined && o.priv !== null;

/** 1.99?? (privacy controls S5): the incog_cams switch (incogcams.js) - false while it can't be asked. */
const icOn = () => { try { return require("./incogcams").isOn() === true; } catch (e) { return false; } };
/** A page-safe veiled user. */
const veiledU = (kind) => ({ anon: true, display: "someone", veil: kind });

/**
 * One v2 event with a priv block -> a page-safe veiled feed item, or null (not a kind the pad shows, or malformed). The real identity
 * rides on it as _vz / _vw (non-enumerable) and what the frog-name session needs as _v2. ts = the event time (ms).
 * (cam.open / cam.close / x.pepe.challenge never get here: they aren't feed types, and Pepe sends them in today's form.)
 */
function veiledItem(ev, ts, opts = {}) {
  const d = ev && ev.data && typeof ev.data === "object" ? ev.data : {};
  const p = parsePriv(d);
  if (!p) return null;
  const T = opts.transcript || "x.pepe.transcript";
  const mine = (r) => (r && owns(r, p) ? r : null);
  let it = null;
  let real = null;
  let active = false, holding;
  if (p.tx && ev.type !== T) return null;                   // (transcripts bar: only a 🎙 line can be masked for !transcripts off)
  switch (ev.type) {
    case "message": {
      real = mine(realUser(d.user, true));
      if (!real) return null;
      it = { k: "msg", ts, u: veiledU(p.kind) };
      if (p.kind === "incognito") { const t = cpStr(d.text, 490); if (!t) return null; it.text = t; }
      else { if (!p.words) return null; it.mask = bucket(p.words); }
      const w = d.web && typeof d.web === "object" ? d.web : null;
      if (w && typeof w.job === "string" && /^w[0-9a-f]{16}$/.test(w.job)) it._job = w.job;
      active = true;
      break;
    }
    case T: {
      real = mine(realUser(d.user));
      if (!real) return null;
      // transcripts bar: masked whatever the identity level - stored exactly as a hidden speaker's 🎙 line (u.veil "hidden", the bar)
      it = { k: "tx", ts, u: veiledU(p.tx ? "hidden" : p.kind) };
      if (p.kind === "incognito" && !p.tx) { const t = cpStr(d.text, 490); if (!t) return null; it.text = t; }
      else { if (!p.words) return null; it.mask = bucket(p.words); }
      if (p.tx) { it.tm = 1; it.tl = p.kind; }                // (1.99aht S1: tl = how the bar's speaker shows - see the header)
      if (/^tx-[0-9a-f]{8,32}$/.test(String(d.id || ""))) it.id = String(d.id);
      const s = Number(d.said_at);
      if (Number.isFinite(s) && s > 0) it.at = Math.round(s * 1000);
      active = true;
      break;
    }
    case "mic.grab":
    case "mic.release": {
      real = mine(realUser(d.user));
      if (!real) return null;
      it = ev.type === "mic.grab" ? { k: "mic", ts, u: veiledU(p.kind) }
        : { k: "unmic", ts, u: veiledU(p.kind), ms: Math.max(0, Math.min(864e5, Number(d.held_ms) || 0)) };
      active = true;
      holding = ev.type === "mic.grab";
      break;
    }
    case "member.join": {
      if (d.initial) return null;
      real = mine(realUser(d.user));
      if (!real) return null;
      it = { k: "join", ts, u: veiledU(p.kind) };
      break;
    }
    case "member.leave": {
      real = mine(realUser(d.user));
      if (!real) return null;
      it = { k: "leave", ts, u: veiledU(p.kind) };
      break;
    }
    default:
      return null;
  }
  const hold = holdOf(d.hold);
  if (hold && (it.k === "mic" || it.k === "unmic" || it.k === "tx")) it.hold = hold;
  it.ah = p.h;
  if (p.hs.length) it.ahs = p.hs.slice();
  // transcripts bar: kind "hidden" (the bar's words, its reveal and its evidence clip work as a hidden line's), tx: 1 (which toggle - the
  // see-through log), lv = the identity level its frog name follows ("tx": none - "someone"; "incognito": their incognito session)
  hide(it, "_vz", { login: real.login, display: real.display, kind: p.tx ? "hidden" : p.kind, h: p.h, hs: p.hs.slice(), sess: null,
                    ...(real.acct ? { acct: true } : {}), ...(p.tx ? { tx: 1, lv: p.kind } : {}) });
  if (p.kind === "hidden" || p.tx) hide(it, "_vw", p.words);
  hide(it, "_v2", { active, holding, proven: !!(d.user && d.user.proven === true), beganNamed: d.began_named === true,
                    leaving: it.k === "leave" });
  return it;
}
/** A v2 event WITHOUT priv (a named person): today's item plus the page-safe v2 extras (hold, at). */
function namedExtras(it, ev) {
  const d = ev && ev.data && typeof ev.data === "object" ? ev.data : {};
  const hold = holdOf(d.hold);
  if (hold && (it.k === "mic" || it.k === "unmic" || it.k === "tx")) it.hold = hold;
  if (it.k === "tx") { const s = Number(d.said_at); if (Number.isFinite(s) && s > 0) it.at = Math.round(s * 1000); }
  return it;
}

// ── the opaque session id ──
function opaqueId(roomId, sess) {
  let key;
  try { key = require("./frognames").secret(); } catch (e) { return null; }
  return "v-" + crypto.createHmac("sha256", key).update("patv/veil-id/v1\0" + String(roomId) + "\0" + String(sess)).digest("base64url").slice(0, 12);
}

// ── frog-name sessions (frognames.js) ──
/** The room's roster names (logins + display names) - a frog name never equals one (C.4). */
function avoidOf(R) {
  const out = [];
  for (const u of [...(R.members || []), ...(R.mic || [])]) {
    if (!u || u.anon) continue;
    if (u.login) out.push(u.login);
    if (u.display) out.push(u.display);
  }
  return out;
}
/** 1.99ahx review fix: a veiled person's own display name - their frog name never reads like it (frognames ownNames: not equal, no word
 *  of it; the login is frognames' own). avoidOf lists named entries only. */
const ownOf = (vz) => (vz && typeof vz.display === "string" && vz.display ? [vz.display] : []);
/** Per room: hold id -> the name its grab got (a release / its 🎙 line reuse it: the session can't end during a hold). */
const HOLDS = new Map();
const HOLDS_MAX = 200;
function holdName(roomId, hold, v) {
  let m = HOLDS.get(roomId);
  if (v === undefined) return m ? m.get(hold) : undefined;
  if (!m) { m = new Map(); HOLDS.set(roomId, m); }
  m.delete(hold);
  m.set(hold, v);
  while (m.size > HOLDS_MAX) m.delete(m.keys().next().value);
  return v;
}
/** review R1: per room, hold id -> the veil kind its last item came with. Pepe keeps a hold's kind as it was when the hold began
 *  (a !bridge show mid-hold leaves it "hidden"), so the SAME kind again is that frozen kind - not the person's level now - and never
 *  ends their frog-name session; a CHANGED kind (incognito -> hidden mid-hold: they went hidden now) does, as any sighting would. */
const HOLD_KINDS = new Map();
function holdKind(roomId, hold, kind) {
  let m = HOLD_KINDS.get(roomId);
  if (kind === undefined) return m ? m.get(hold) : undefined;
  if (!m) { m = new Map(); HOLD_KINDS.set(roomId, m); }
  m.delete(hold);
  m.set(hold, kind);
  while (m.size > HOLDS_MAX) m.delete(m.keys().next().value);
  return kind;
}
/**
 * A veiled item's frog name: sets u.alias / u.hood / u.id (or leaves "someone"), and _vz.sess. B.2: an unproven holder or the release
 * of a hold begun named -> no name (the session is still sighted - they're there). A hold's release / 🎙 line reuse its grab's name.
 */
async function nameItem(R, it) {
  const FN = require("./frognames");
  const vz = it._vz, v2 = it._v2 || {};
  if (!vz) return it;
  // 1.99aht transcripts bar: a NAMED speaker's 🎙 line masked only for !transcripts off gets no frog name - no frog-name session is
  // opened, sighted or ended for them (their grab / release are named; 1.99aht S1: the page shows the bar under their name). An incognito
  // one's line follows their incognito session (lv), never the bar's "hidden" level (that would end it - M addendum 3 #1)
  if (vz.tx && vz.lv === "tx") return it;
  const lvl = vz.tx && vz.lv ? vz.lv : vz.kind;
  const roomId = R.id;
  let view = null;
  try {
    if (v2.leaving) {
      // privacy fix (M addendum 3 #1): a "hidden" leave of someone whose open session is incognito ends it first - the leave never
      // carries the incognito frog name under a hidden veil
      await FN.level(roomId, vz.login, vz.kind, it.ts);
      view = FN.current(roomId, vz.login, it.ts);              // (1.99ahx review fix: a leave from before a frog name took over: "someone")
      await FN.left(roomId, vz.login, it.ts);
    } else {
      // review R1: a hold's item at the kind its hold already had is the hold's frozen kind (see holdKind); the first one (the grab,
      // or the first seen after a restart) and a changed one decide the level as usual (fails closed)
      let frozen = false;
      if (it.hold && lvl) {
        frozen = holdKind(roomId, it.hold) === lvl;
        holdKind(roomId, it.hold, lvl);
      }
      // (1.99ahx review fix: + their own display name - a veiled person isn't in avoidOf's named roster; frognames adds the login.
      // onMic: an item of a mic hold - its grab, 🎙 line or release - never ends the no-name 15 minutes, even when a restart forgot the hold)
      view = await FN.sight(roomId, vz.login, { t: it.ts, active: !!v2.active, holding: v2.holding, avoidNames: avoidOf(R), ownNames: ownOf(vz),
                                                 kind: lvl, frozen, onMic: it.k === "mic" || it.k === "unmic" || !!it.hold });
    }
  } catch (e) { view = null; console.error("[veil] frog name:", e && e.code ? e.code : "error"); }
  let named = view && view.alias ? view : null;
  if (it.hold) {
    const was = holdName(roomId, it.hold);
    if (it.k === "mic") holdName(roomId, it.hold, named && v2.proven ? named : null);
    // the grab's verdict (a name, or "someone") for the whole hold - privacy fix: only while it is still the same session (an
    // incognito -> hidden switch mid-hold ends it at once: the release / 🎙 line then never shows the grab's incognito name)
    else if (was !== undefined) named = was && view && view.session === was.session ? was : null;
  }
  if ((it.k === "mic" || it.k === "unmic") && (!v2.proven || v2.beganNamed)) named = null;
  if (named) {
    it.u.alias = named.alias;
    if (named.hood != null) it.u.hood = named.hood;
    const id = opaqueId(roomId, named.session);
    if (id) it.u.id = id;
  }
  if (view && view.session != null) vz.sess = view.session;
  return it;
}
/** Review fix (A-compat-1): a NAMED mic grab with a hold id - that whole hold's verdict is "someone" (a veiled 🎙 line or release of
 *  the same hold - its holder went private mid-hold - never carries a frog name or the hold id the named grab showed). */
function namedHold(roomId, hold) {
  const h = holdOf(hold);
  if (h && holdName(roomId, h) === undefined) holdName(roomId, h, null);
  if (h) {
    let m = BEGAN_NAMED.get(roomId);
    if (!m) { m = new Map(); BEGAN_NAMED.set(roomId, m); }
    m.delete(h);
    m.set(h, true);
    while (m.size > HOLDS_MAX) m.delete(m.keys().next().value);
  }
}
/** privacy fix (C, spec B.2 / B.4 "named-then-veiled hold"): per room, the holds whose grab came NAMED (a release of one is "someone"). */
const BEGAN_NAMED = new Map();
/**
 * privacy fix (C): did hold `hold` of bridge room R begin NAMED - its grab seen named here (namedHold), or, after a restart, a named
 * grab with that hold id still in the live feed? Pepe sends the RELEASE of such a hold in today's anonymous form (no priv) when he
 * can't tie the veil to the holder - an unresolved roster name (B-1b `anon`), a veil key that isn't provably theirs (A-compat-2) -
 * and it used to be dropped for everyone (a hashless anonymous drop without a stamped grab). The spec's rule for that release is
 * "someone dropped the mic" (B.2): bridge.js stamps it showable (k3) and the page shows it as plain "someone", never the hold id.
 * once: the hold's release - forgotten after (a hold id is never reused).
 */
function beganNamed(R, hold, once = false) {
  const h = holdOf(hold);
  if (!h || !R) return false;
  const m = BEGAN_NAMED.get(R.id);
  let yes = !!(m && m.get(h));
  if (!yes) yes = (R.feed || []).some((x) => x && x.k === "mic" && x.hold === h && x.u && !x.u.anon && x.u.login);
  if (yes && once && m) m.delete(h);
  return yes;
}
/** A NAMED sighting of a login in a pad (C.2: no frog name for them there for 15 minutes) - and their open session, if any, ends
 *  (their level is back to normal). Cheap: an HMAC; the session check is in memory. */
function namedSeen(roomId, login, t) {
  if (!login || /^u:/i.test(String(login))) return;
  try {
    const FN = require("./frognames");
    FN.named(roomId, login, t);
    if (FN.current(roomId, login)) FN.off(login, roomId, t).catch(() => {});
  } catch (e) { /* frog names unavailable: nothing to note */ }
}

// ── snapshots ──
// wave2 integration review (T-4): a veiled holder's hold start is clamped exactly like a named one's (bridge.cleanMic: no more
// than 6 h back, 5 s ahead of the sync's own time) - micfollow ranks covers and named tiles on one scale (min_hold, spam_short,
// "newest", displacement), whatever Pepe's clock says
const SINCE_PAST_MS = 6 * 3600 * 1000, SINCE_AHEAD_MS = 5 * 1000;
const clampSince = (sec, now) => {
  const s = Number(sec);
  return Number.isFinite(s) && s > 0 ? Math.max(now - SINCE_PAST_MS, Math.min(now + SINCE_AHEAD_MS, Math.round(s * 1000))) : null;
};
/**
 * Pepe's v2 snapshot members[] / mic[] -> page-safe entries (veiled: anon + veil + frog name, never on_cam - 1.99?? privacy
 * controls S5: an incognito member's on_cam is kept server-side on _vz while incognito cams are on; real identity as _vz),
 * named entries through `clean` (bridge.cleanUser / cleanMic). Sightings: every veiled member is sighted (frognames.sight, quiet),
 * every named member is noted named (on EVERY snapshot - C.2), veiled members gone since the last snapshot have left.
 * Review fix (A-privacy-8): an entry whose priv block is present but doesn't parse (too many hashes, a bad h, an unknown kind) or
 * whose UserRef isn't one of its hashes (A-compat-2) is DROPPED - never shown named with its real login and cam (fails closed, as
 * feedItemV2 drops such an event). A holder's began_named rides on its identity (B.2: no frog name in the mic list either).
 */
async function snapshotEntries(R, list, clean, { mic = false, max = 400, now = Date.now() } = {}) {
  const out = [];
  for (const u of (Array.isArray(list) ? list : []).slice(0, max)) {
    const veiled = hasPriv(u);
    const p = veiled ? parsePriv({ priv: u.priv }) : null;
    if (!veiled) { const c = clean(u); if (c) out.push(c); continue; }
    if (!p || p.tx) continue;                               // (transcripts bar: a 🎙 line's mark, never a roster entry's - fails closed)
    const real = realUser(u);
    if (!real || !owns(real, p)) continue;
    const e = veiledU(p.kind);
    if (!mic) {
      if (u.on_mic) e.on_mic = true;
      if (u.src === "list" || u.src === "seen") e.src = u.src;
    }
    hide(e, "_vz", { login: real.login, display: real.display, kind: p.kind, h: p.h, hs: p.hs.slice(), sess: null,
                     ...(mic ? { proven: u.proven === true, since: clampSince(u.since, now),
                                 ...(u.began_named === true ? { beganNamed: true } : {}) } : {}),
                     // 1.99?? (privacy controls S5): an INCOGNITO member's cam state (Pepe sends it only while incognito cams are
                     // advertised) - server-only on _vz; chatlogview.roster shows it on the page only while they're effective
                     ...(!mic && p.kind === "incognito" && typeof u.on_cam === "boolean" && icOn() ? { on_cam: u.on_cam } : {}) });
    out.push(e);
  }
  return out;
}
/**
 * Frog names for a snapshot's veiled entries (members first, then holders - one session per person) + left / named bookkeeping.
 * Review fix (A-privacy-1 / A-compat-1): EVERY named roster and mic entry is a named sighting on every snapshot (C.2: lastNamed
 * counts roster entries) - not only a login new to the roster. Someone who sat named in the people list for 40 minutes and then
 * switches a veil on gets no frog name in the same slot (FN.named is an HMAC and a Map set). Never for a login this same snapshot
 * also lists veiled (a session it just sighted isn't ended by its own snapshot).
 */
async function nameSnapshot(R, now) {
  const FN = require("./frognames");
  const prev = R._veilSeen || new Set();
  const seen = new Set();
  const named = new Set();
  const avoid = avoidOf(R);
  // review R1: the level is a PERSON's, not an entry's. Pepe gives a roster entry the person's level now, but a mic entry its hold's
  // level as it was when the hold began (a hold begun hidden stays "hidden" after a !bridge show) - sighting both with their own kind
  // ended the session and burnt the name on every snapshot of the hold (incognito roster entry, then "hidden" mic entry). Every
  // entry of a person on the roster is sighted at their roster level (the strictest, if listed twice); a holder not on the roster
  // at their mic entry's.
  const personKind = new Map();
  // 1.99ahx review fix: who this snapshot shows holding the mic (the mic list, or a roster entry's on_mic) - their no-name 15 minutes
  // never end on it (frognames onMic): a restart forgets the hold, and a batch's snapshot is sighted before the batch's grab
  const onMic = new Set();
  for (const e of R.mic || []) if (e && e.anon && e._vz && e._vz.login) onMic.add(lower(e._vz.login));
  for (const e of R.members || []) if (e && e.anon && e.on_mic === true && e._vz && e._vz.login) onMic.add(lower(e._vz.login));
  for (const e of R.members || []) {
    const vz = e && e.anon && e._vz;
    if (!vz || !vz.login) continue;
    const low = lower(vz.login);
    if (personKind.get(low) !== "hidden") personKind.set(low, vz.kind);
  }
  for (const e of [...(R.members || []), ...(R.mic || [])]) {
    if (!e) continue;
    if (!e.anon && e.login) { named.add(lower(e.login)); continue; }
    const vz = e._vz;
    if (!vz) continue;
    const low = lower(vz.login);
    const kind = personKind.has(low) ? personKind.get(low) : vz.kind;
    let view = null;
    try { view = await FN.sight(R.id, vz.login, { t: now, active: false, avoidNames: avoid, ownNames: ownOf(vz), kind,
                                                onMic: onMic.has(low) }); } catch (err) { view = null; }
    seen.add(low);
    const isMic = (R.mic || []).includes(e);
    if (view && view.alias && !(isMic && (vz.proven !== true || vz.beganNamed === true))) {
      e.alias = view.alias;
      if (view.hood != null) e.hood = view.hood;
      const id = opaqueId(R.id, view.session);
      if (id) e.id = id;
    }
    if (view && view.session != null) vz.sess = view.session;
  }
  for (const low of prev) if (!seen.has(low)) FN.left(R.id, low, now).catch(() => {});
  for (const low of named) if (!seen.has(low)) namedSeen(R.id, low, now);
  hide(R, "_veilSeen", seen);
  hide(R, "_namedSeen", named);
}
/**
 * Review fix (A-privacy-6): the order veiled entries are listed in carries no join information. Pepe sends members by `since`; a
 * veiled entry kept at its index would sit in the exact slot of the named entry it replaced (and the reverse on un-veil). Named
 * entries keep their order; veiled ones go after them, by frog name, alias-less ones last in the order of a keyed hash of their
 * session (stable, meaningless). -> a new array (or the same one when nothing is veiled).
 */
function veilOrder(list, roomId) {
  const named = [], veiled = [];
  for (const e of Array.isArray(list) ? list : []) (e && e.anon && e.veil ? veiled : named).push(e);
  if (!veiled.length) return list;
  const key = (e) => (e.alias ? "0" + String(e.alias).toLowerCase() : "1" + (opaqueId(roomId, e._vz && e._vz.sess != null ? e._vz.sess : "") || ""));
  veiled.sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
  return named.concat(veiled);
}
/** Review fix (A-compat-5): at boot, the veiled people a room's restored roster lists count as seen - the first snapshot that no
 *  longer has them starts their away clock (J-8), instead of an empty memory that never notices they left during the restart. */
function seedSeen(R) {
  const s = new Set();
  for (const e of [...(R.members || []), ...(R.mic || [])]) if (e && e.anon && e._vz && e._vz.login) s.add(lower(e._vz.login));
  hide(R, "_veilSeen", s);
  return s.size;
}

// ── storage ──
/** The bridge_veil row of a live item: {vz, vw} JSON / words, or null for a named item. */
function veilRow(it) {
  const vz = it && it._vz;
  if (!vz) return null;
  return { vz: JSON.stringify(vz), vw: typeof it._vw === "string" ? it._vw : null };
}
/** bridge_rooms_veil's data for a room: the veiled entries' identities by index. */
function roomVeilData(R) {
  const pick = (list) => (list || []).map((e, i) => (e && e._vz ? [i, e._vz] : null)).filter(Boolean);
  const m = pick(R.members), c = pick(R.mic);
  return m.length || c.length ? JSON.stringify({ members: m, mic: c }) : null;
}
/** At boot: re-attach the identities of a room's veiled entries (by index, only onto anon + veil entries). */
function attachRoomVeil(R, data) {
  let o = null;
  try { o = JSON.parse(data || "null"); } catch (e) { o = null; }
  if (!o || typeof o !== "object") return 0;
  let n = 0;
  for (const [key, list] of [["members", R.members], ["mic", R.mic]]) {
    for (const pair of Array.isArray(o[key]) ? o[key] : []) {
      const e = Array.isArray(pair) ? (list || [])[pair[0]] : null;
      if (e && e.anon && e.veil && pair[1] && typeof pair[1] === "object") { hide(e, "_vz", pair[1]); n++; }
    }
  }
  return n;
}
/** At boot: re-attach the identities of a room's veiled live items from bridge_veil. */
async function attachFeedVeil(R) {
  const cs = (R.feed || []).filter((it) => it && it.u && it.u.anon && it.u.veil).map((it) => Number(it.c));
  if (!cs.length) return 0;
  const by = new Map();
  for (let i = 0; i < cs.length; i += 400) {
    const part = cs.slice(i, i + 400);
    for (const r of await getQuery(`SELECT c, vz, vw FROM bridge_veil WHERE c IN (${part.map(() => "?").join(",")})`, part)) by.set(Number(r.c), r);
  }
  let n = 0;
  for (const it of R.feed) {
    const r = it && by.get(Number(it.c));
    if (!r) continue;
    try { hide(it, "_vz", JSON.parse(r.vz)); } catch (e) { continue; }
    if (r.vw != null) hide(it, "_vw", String(r.vw));
    n++;
  }
  return n;
}

/** Forget-me / account deletion (A.4.8): every trace of these logins in the live side tables. -> {feed: [c...], rooms: n}. The
 *  caller turns those feed items into "left out" (their hash is left out by the same request). */
async function forgetLogins(logins) {
  const set = new Set((Array.isArray(logins) ? logins : [logins]).map(lower).filter(Boolean));
  if (!set.size) return { feed: [], rooms: 0 };
  const cs = [];
  for (const r of await getQuery("SELECT c, vz FROM bridge_veil")) {
    let vz = null;
    try { vz = JSON.parse(r.vz); } catch (e) { vz = null; }
    if (vz && set.has(lower(vz.login))) cs.push(Number(r.c));
  }
  for (let i = 0; i < cs.length; i += 400) {
    const part = cs.slice(i, i + 400);
    await runQuery(`DELETE FROM bridge_veil WHERE c IN (${part.map(() => "?").join(",")})`, part);
  }
  let rooms = 0;
  for (const r of await getQuery("SELECT id, data FROM bridge_rooms_veil")) {
    let o = null;
    try { o = JSON.parse(r.data); } catch (e) { o = null; }
    if (!o) continue;
    let changed = false;
    for (const key of ["members", "mic"]) {
      const before = Array.isArray(o[key]) ? o[key] : [];
      o[key] = before.filter((p) => !(Array.isArray(p) && p[1] && set.has(lower(p[1].login))));
      if (o[key].length !== before.length) changed = true;
    }
    if (changed) { await runQuery("UPDATE bridge_rooms_veil SET data = ? WHERE id = ?", [JSON.stringify(o), r.id]); rooms++; }
  }
  return { feed: cs, rooms };
}

module.exports = { KINDS, hide, bucket, parsePriv, realUser, veiledItem, namedExtras, opaqueId, nameItem, namedSeen, namedHold, beganNamed, snapshotEntries,
                   nameSnapshot, veilOrder, seedSeen, veilRow, roomVeilData, attachRoomVeil, attachFeedVeil, forgetLogins, avoidOf,
                   hiddenHash, owns, hasPriv, _holds: HOLDS, _beganNamed: BEGAN_NAMED, _holdKinds: HOLD_KINDS };
