// plexchat.js — 1.99ajk: 📼 PLEX FROM CHAT. Pepe's one bot route for "pepe play the matrix" / "!plex alien -cam" in a Camfrog room
// or a pad's web chat: search the library, start a title / an episode / a season on the pad's stage, queue it behind what's on,
// put it on Pepe's main stream (staff), the controls, what's playing.
//
// WHO: the site resolves the SPEAKER, never Pepe's typed text - {user_id} (a web chat job: the account the site put on it) or
// {login} (a proven Camfrog login -> the PATV account linked to it: users.camfrogUsername, a real account preferred over a CF auto
// one). No account, or only a CF auto account (nobody can sign in to it) -> code "link"; an archived account -> "account".
// RULES: exactly the user path's - nothing is copied here. medialib.playFor / mediaqueue.startFor are the functions the /stage
// routes (and the Room Dock) call: library access, the pad's visibility (seesPad), preflight (one library stream per pad, banned,
// own open slot, the daily cap), the pad's 📼 limit, the price / estimate the person said yes to (400 / 409 re-ask), a free
// encoder, the slot. On top, for chat: the pad's 18+ gate (padaccess.adultGate - a chat speaker never confirmed their age on the
// site for that pad). Queueing behind what's on = mediaqueue.addNext (the queue's starter, or a free queue's controllers).
// Pepe's cam = onair.libraryFor (onair.operate, on-air on, allow_library; busy -> onair_busy with what's on; next -> a ⏰ row).
// Controls = medialib / mediaqueue as that user (mayControl inside).
// PRIVACY: titles only - file paths never leave (mediactl's briefs carry none; anything named `file` is dropped anyway). Results
// only after access + the pad's visibility. "rpm" writes a private pad-chat row (roompm) for an account on a pad it sees.
//
//   POST /api/medialib/bot   {password, op, as: {login} | {user_id}, room, via: room | web, ...}
//     search    {q, year?, season?, episode?, target: stage | cam}  -> {rows (<= 5), free, how, per_hour, state, target, pad}
//     play      {key, scope: title | episode | season | season_rest | series_from, target, price?, estimate?, mode: now | next | replace}
//               (plexreplace: target stage + mode replace = ▶ "Play this instead" - ONE request: what's on the pad comes off, the new title
//                goes on with its feature and card - medialib.playFor / mediaqueue.startFor {replace: true}; -> + replaced {title, queue})
//     control   {action: pause | resume | stop | seek | seek_rel | next | prev, value}
//     np        {target?}                                             -> the pad's 📼 player (read-only view) + the on-air label
//     continue  {show?}                                               -> the speaker's next episode (last 14 days) as one row
//     rpm       {text}                                                -> a private "only you can see this" row for that account
//   refusals: {ok: false, code, error, price?, estimate?, label?, cap?, need?, have?, max?, by?} - code is one of CODES
"use strict";
const express = require("express");
const { getQuery } = require("./dbUtils");

const ML = () => require("./medialib");
const MQ = () => require("./mediaqueue");
const OA = () => require("./onair");
const rooms = () => require("./rooms");
const conf = () => require("./mediaconf");
const PA = () => require("./padaccess");

const CODES = ["signin", "off", "cap", "pad", "banned", "has_slot", "busy_library", "busy_queue", "slot_taken", "site_full", "encoder_busy",
  "encoder_down", "too_long", "price", "estimate", "pat", "control_denied", "nothing_on", "last_title", "first_title", "queue_full", "not_starter",
  "not_playing", "queue_off", "onair_off", "onair_library_off", "onair_staff", "onair_busy", "irl", "pepe_away", "rate", "link", "account", "bad",
  "not_found", "error", "replace_gone", "replace_changed", "play_changed"];
const OPS = new Set(["search", "play", "control", "np", "continue", "rpm"]);
const SCOPES = new Set(["title", "episode", "season", "season_rest", "series_from"]);
const RATE_MAX = 30, RATE_MS = 60 * 1000;
const CONTINUE_MS = 14 * 24 * 3600 * 1000;

let clock = () => Date.now();
const now = () => clock();

class Fail extends Error {
  constructor(code, message, status = 400, extra = null) { super(message); this.code = code; this.status = status; this.refuse = true; if (extra) this.extra = extra; }
}

// ── the speaker ──
async function userRow(sql, args) { try { return await getQuery(sql, args); } catch (e) { return []; } }
/** {user_id} | {login} -> {userId, username, class}. Throws Fail link | account. */
async function resolve(as) {
  const a = as && typeof as === "object" ? as : {};
  let rows = [];
  if (a.user_id != null && String(a.user_id).trim()) {
    rows = await userRow("SELECT * FROM users WHERE userId = ?", [String(a.user_id).trim().slice(0, 80)]);
  } else if (a.login != null && String(a.login).trim()) {
    const login = String(a.login).trim().toLowerCase().slice(0, 40);
    if (/^u:/.test(login)) throw new Fail("link", "Link your account first.", 403);     // an account nick is never a login
    rows = await userRow("SELECT * FROM users WHERE lower(camfrogUsername) = ? ORDER BY userId", [login]);
  } else throw new Fail("link", "Link your account first.", 403);
  const AA = require("./autoaccount");
  let pick = null;
  for (const r of rows) {
    let auto = false;
    try { auto = await AA.isAutoAccount(r.userId); } catch (e) { auto = false; }
    if (!auto) { pick = r; break; }
  }
  if (!pick) throw new Fail("link", "Plex plays run on your PATV account - link it (or sign up) first.", 403);
  if (pick.archived_at != null && pick.archived_at !== "" && pick.archived_at !== 0) throw new Fail("account", "This account can't do that.", 403);
  return { userId: String(pick.userId), username: pick.username, class: pick.class || null };
}

// ── refusals -> stable codes ──
const ALIAS = { full: "queue_full", library: "onair_library_off", staff_only: "onair_staff", when: "bad", embed_bad: "bad", owner: "onair_staff",
                gone: "not_found", adult: "pad", pad_private: "pad" };
const num = (s) => Number(String(s || "").replace(/[^\d]/g, "")) || 0;
// 1.99ajk plexchat review: only a REFUSAL (a Refuse / Fail - e.refuse) carries a code and its words to the room; anything else is a
// crash (SQLITE_BUSY, ECONNRESET, a TypeError ...) - code "error", a generic line, and its stack in the log - never its message
function codeOf(e) {
  if (!e) return "error";
  const refusal = !!(e.refuse || e instanceof Fail);
  const c = e.code || (e.extra && e.extra.code);
  if (refusal && c && typeof c === "string") {
    const k = ALIAS[c] || c;
    if (CODES.includes(k)) return k;
    if (/^[a-z][a-z_]{1,29}$/.test(k)) return k;                       // a refusal's own (newer) code: Pepe falls back to its words
  }
  const msg = String(e.message || "");
  if (!refusal) return e.status === 503 || e.status === 502 ? "encoder_down" : "error";
  if (e.status === 402) return "pat";
  if (e.status === 401) return "signin";
  if (/No such pad/i.test(msg)) return "pad";
  if (/Not in the Plex library/i.test(msg)) return "not_found";
  if (e.status === 503 || e.status === 502) return "encoder_down";
  return e.status && e.status >= 500 ? "error" : "bad";
}
function failBody(e) {
  const code = codeOf(e);
  const x = { ...(e && e.extra ? e.extra : {}) };
  const refusal = !!(e && (e.refuse || e instanceof Fail));
  const out = { ok: false, code, error: refusal && code !== "error" ? String(e.message || "Something went wrong.").slice(0, 300) : "Something went wrong." };
  for (const k of ["price", "estimate", "cap", "max", "busy", "max_minutes", "by"]) if (x[k] != null) out[k] = x[k];
  // plexreplace: a busy pad says what's on and whether this speaker may replace it (Pepe offers "play X instead?" then)
  if (x.can_replace != null) out.can_replace = !!x.can_replace;
  if (x.playing != null) out.playing = String(x.playing).slice(0, 120);
  if (x.playing_queue != null) out.playing_queue = !!x.playing_queue;
  if (x.playing_left != null) out.playing_left = Math.max(0, Math.floor(Number(x.playing_left) || 0));
  if (x.playing_slot != null) out.playing_slot = String(x.playing_slot).slice(0, 64);   // (review fix: the slot Pepe names with the yes)
  if (e && e.price != null && out.price == null) out.price = e.price;
  if (e && e.label) out.label = String(e.label).slice(0, 120);
  if (code === "pat") {                       // shop.chargeService: "That costs X PAT and you have Y."
    const m = /costs\s+([\d,.]+)\s+PAT\s+and\s+you\s+have\s+([\d,.]+)/i.exec(out.error);
    if (m) { out.need = num(m[1]); out.have = num(m[2]); }
  }
  delete out.file;
  return out;
}

// ── helpers ──
const clean = (v, n = 100) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const intOr = (v, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ").replace(/^(the|a|an) /, "").trim();
async function padOf(room) {
  const R = await ML()._q.roomOf(room);
  if (!R) throw new Fail("pad", "No such pad.", 404);
  return R;
}
/** The pad must be one this account may see (Approved pads: inside only) and past its 18+ gate. */
async function seeOrFail(user, R) {
  const stage = require("./mainstage");
  if (!(await stage.seesPad(user, R.id))) throw new Fail("pad", "No such pad.", 404);
  let gate = null;
  try {
    await PA().init();
    gate = PA().adultGate(user, R.id);
  } catch (e) {
    // 1.99ajk plexchat review: the 18+ check FAILS CLOSED - if it can't be asked, the pad reads as no such pad
    console.error("[plexchat] the 18+ gate couldn't be checked:", e && e.message ? e.message : e);
    gate = null;
  }
  if (gate !== "ok") throw new Fail("pad", "No such pad.", 404);
}
/** Pepe's cam from chat: Staff (onair.operate), on-air on, allow_library - the same order onair.libraryFor checks them in. */
async function camOrFail(user) {
  const SP = require("./siteperms");
  await OA().init();
  if (!SP.can(user, "onair.operate")) throw new Fail("onair_staff", "Only staff can put things on Pepe's stream.", 403);
  const C = OA().config();
  if (!C.enabled) throw new Fail("onair_off", OA().WHY.off, 409);
  if (!C.allow_library) throw new Fail("onair_library_off", OA().WHY.library, 409);
}
const slim = (r) => {
  const o = {};
  for (const k of ["key", "type", "title", "year", "show", "season", "episode", "duration", "items", "total_sec", "price", "estimate", "scope",
                   "label", "exact", "first_title", "leafs", "next_cost"]) if (r[k] !== undefined && r[k] !== null) o[k] = r[k];
  return o;
};
const labelOf = (it) => (it.type === "episode" && it.show
  ? `${it.show} S${it.season == null ? 0 : it.season}E${it.episode == null ? 0 : it.episode}${it.title ? ` "${it.title}"` : ""}`
  : `${it.title}${it.year ? ` (${it.year})` : ""}`).slice(0, 120);

/** How well a search brief matches what was asked (higher = better). */
function score(it, q, want) {
  const t = norm(it.type === "episode" ? it.show || it.title : it.title), n = norm(q);
  let s = 0;
  if (!n) s = 10;
  else if (t === n) s = 100;
  else if (t.startsWith(n) || n.startsWith(t + " ")) s = 75;          // "alien" -> Aliens / Alien: Romulus (Plex's order breaks the tie)
  else if (n.split(" ").every((w) => (" " + t + " ").includes(" " + w + " "))) s = 60;
  else if (t.includes(n)) s = 50;
  else s = 30;
  if (it.type === "episode" && norm(it.title) === n) s = Math.max(s, 70);       // an episode asked for by its own title
  if (want.year) s += Number(it.year) === want.year ? 30 : -40;
  if (want.season != null || want.episode != null) s += it.type === "show" ? 25 : it.type === "episode" ? 10 : -30;
  else if (it.type === "episode" && norm(it.title) !== n) s -= 20;
  // 1.99ajk plexchat review: "the fargo movie" / "the office show" - what the person called it
  if (want.hint === "movie") s += it.type === "movie" ? 15 : -15;
  else if (want.hint === "show") s += it.type === "movie" ? -15 : 15;
  return s;
}

// ── ops ──
async function opSearch(user, b) {
  const target = b.target === "cam" ? "cam" : "stage";
  const R = target === "cam" ? await padOf(rooms().HOUSE_ROOM) : await padOf(b.room);
  await seeOrFail(user, R);
  if (target === "cam") await camOrFail(user);                          // no picker for a cam pick that can't happen
  await ML().init();
  const A = await ML()._q.mustAccess(user);
  const q = clean(b.q, 100);
  if (q.length < 2) throw new Fail("bad", "Say a title.", 400);
  const want = { year: intOr(b.year, 1880, 2100), season: intOr(b.season, 0, 200), episode: intOr(b.episode, 0, 2000),
                 hint: b.hint === "movie" || b.hint === "show" ? b.hint : null };
  const S = conf().get();
  const per = A.free ? 0 : Math.max(0, Math.floor(Number(S.library_price) || 0));
  const found = (await ML().search(user, q)).filter((x) => x && ["movie", "show", "episode"].includes(x.type));
  const ranked = found.map((it, i) => ({ it, s: score(it, q, want), i })).sort((a, b2) => (b2.s - a.s) || (a.i - b2.i)).slice(0, 8);
  const rows = [];
  let shows = 0;
  for (const { it, s } of ranked) {
    if (rows.length >= 5) break;
    const exact = s >= 100;
    if (it.type === "movie") {
      rows.push(slim({ key: String(it.key), type: "movie", title: it.title, year: it.year, duration: it.duration, scope: "title", exact,
                       price: per ? ML().priceFor(it.duration, 0, S).price : 0, label: labelOf(it) }));
    } else if (it.type === "episode") {
      rows.push(slim({ key: String(it.key), type: "episode", title: it.title, show: it.show, season: it.season, episode: it.episode, year: it.year,
                       duration: it.duration, scope: "episode", exact: exact && want.episode == null, price: per ? ML().priceFor(it.duration, 0, S).price : 0,
                       estimate: per ? MQ().estimate(per, it.duration) : 0, label: labelOf(it) }));
    } else if (it.type === "show") {
      if (shows >= 3) continue;                                          // each show costs a lookup: the best few only
      shows++;
      const show = await ML()._q.fetchItem(it.key).catch(() => null);
      const eps = MQ().sortEps((show && show.episodes) || []);
      if (!eps.length) continue;
      const real = eps.filter((e) => (Number(e.season) || 0) !== 0);
      if (want.season != null && want.episode == null) {
        const se = eps.filter((e) => (Number(e.season) || 0) === want.season);
        if (!se.length) continue;
        const capped = MQ().capQueue(se.map(MQ().slim), 0, { maxItems: S.library_queue_max_items || 60, maxSec: (S.library_queue_max_hours || 12) * 3600 });
        rows.push(slim({ key: String(se[0].key), type: "season", show: it.title, title: it.title, year: it.year, season: want.season, scope: "season",
                         items: capped.items.length, total_sec: capped.total_sec, exact, estimate: per ? MQ().estimate(per, capped.total_sec) : 0,
                         first_title: se[0].title || null, label: `${it.title} S${want.season}` }));
      } else {
        const sn = want.season != null ? want.season : 1;
        const e = want.episode != null ? eps.find((x) => (Number(x.season) || 0) === sn && Number(x.episode) === want.episode)
          : (real[0] || eps[0]);
        if (!e) continue;
        rows.push(slim({ key: String(e.key), type: "episode", title: e.title, show: e.show || it.title, season: e.season, episode: e.episode, year: it.year,
                         duration: e.duration, scope: "episode", exact, price: per ? ML().priceFor(e.duration, 0, S).price : 0,
                         estimate: per ? MQ().estimate(per, e.duration) : 0, label: labelOf({ ...e, show: e.show || it.title }) }));
      }
    }
  }
  const state = await ML().padState(user, R.id).catch(() => null);
  // 1.99ajk plexchat review: the pad's running 📼 queue that this speaker may add to (its starter): what each row would ADD to that
  // queue's bill (its own per-hour rate, on top of what's paid) - "queue it next" confirms that figure, not a standalone price
  if (target === "stage" && state && state.library && state.library.queue && state.library.can_add) {
    for (const row of rows) {
      const secs = row.type === "season" ? row.total_sec : row.duration;
      row.next_cost = (await MQ().addCostFor(R.id, secs || 0).catch(() => null)) || 0;
    }
  }
  return { ok: true, rows, free: !!A.free, how: A.how || null, per_hour: per, state, target, pad: { id: R.id, title: R.title || R.id } };
}

async function opPlay(user, b, ctx) {
  const target = b.target === "cam" ? "cam" : "stage";
  const key = String(b.key == null ? "" : b.key);
  if (!/^\d{1,12}$/.test(key)) throw new Fail("bad", "Bad item.", 400);
  const scope = SCOPES.has(b.scope) ? b.scope : "title";
  const price = b.price == null || b.price === "" ? undefined : Math.floor(Number(b.price));
  if (target === "cam") {
    const R = await padOf(rooms().HOUSE_ROOM);
    await seeOrFail(user, R);
    const by = ctx.via === "web" ? "web:" + user.username : "pepe:" + (clean(ctx.login, 40) || user.username);
    const r = await OA().libraryFor(user, key, by, { price, mode: ["now", "next", "replace"].includes(b.mode) ? b.mode : "now" });
    const T = (OA().view() || {}).target || null;
    return { ok: true, target: "cam", queued: !!(r && r.queued), irl: !!(r && r.irl), title: r && r.title ? r.title : null, id: r && r.id ? r.id : null,
             ahead: r && r.ahead != null ? r.ahead : null, on_air: T ? T.label : null };
  }
  const R = await padOf(b.room);
  await seeOrFail(user, R);
  if (b.mode === "next") {
    // on a paid queue: what it adds to the starter's bill, as the starter said yes to it (400 / 409 estimate otherwise)
    const est = b.estimate == null || b.estimate === "" ? undefined : Math.floor(Number(b.estimate));
    const r = await MQ().addNext(user, R.id, [key], { estimate: est, scope: scope === "title" || scope === "episode" ? null : scope });
    return { ok: true, target: "stage", queued: true, title: r.next, added: r.added, cost: r.cost || 0, pad: { id: R.id, title: R.title || R.id } };
  }
  const S = conf().get();
  // plexreplace: Pepe's "play X instead?" + yes. Review fix: replace_slot = the slot his question named (padState library.slot_id / a busy
  // refusal's playing_slot) - the site refuses replace_changed if something else is on by the yes; an older Pepe without it: whatever is on
  const slotArg = typeof b.replace_slot === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.replace_slot) ? b.replace_slot : null;
  const rep = b.mode === "replace" ? { replace: slotArg || true } : {};
  const replaced = (r) => (r && r.replaced ? { replaced: { title: r.replaced.title || null, queue: !!r.replaced.queue } } : {});
  if (scope === "title" || (scope === "episode" && S.library_queue === false)) {
    const r = await ML().playFor(user, { room: R.id, key, ...(price !== undefined ? { price } : {}), ...rep });
    return { ok: true, target: "stage", title: r.title, price: r.price || 0, queue: false, pad: { id: R.id, title: R.title || R.id }, ...replaced(r) };
  }
  const estimate = b.estimate == null || b.estimate === "" ? undefined : Math.floor(Number(b.estimate));
  const r = await MQ().startFor(user, { room: R.id, key, scope, ...(estimate !== undefined ? { estimate } : {}), ...rep });
  return { ok: true, target: "stage", title: r.title, price: r.price || 0, queue: true, items: r.items, total_sec: r.total_sec, estimate: r.estimate || 0,
           per_hour: r.per_hour || 0, pad: { id: R.id, title: R.title || R.id }, ...replaced(r) };
}

async function opControl(user, b) {
  const R = await padOf(b.room);
  await seeOrFail(user, R);
  const action = String(b.action || "");
  const clock_ = ML()._q.clock;
  const pad = { id: R.id, title: R.title || R.id };
  const s = await ML()._q.session(R.id);
  if (action === "pause") { const r = await ML().pause(user, R.id); return { ok: true, action, at: clock_(r.position || 0), pad }; }
  if (action === "resume") { await ML().resume(user, R.id); return { ok: true, action, pad }; }
  if (action === "stop") { await ML().stop(user, R.id, "stopped"); return { ok: true, action, pad }; }
  if (action === "seek" || action === "seek_rel") {
    if (!s) throw new Fail("nothing_on", "Nothing from the library is playing on this pad.", 404);
    const v = Math.floor(Number(b.value));
    if (!Number.isFinite(v)) throw new Fail("bad", "Bad position.", 400);
    const here = Math.max(0, Number(s.position) || 0) + (s.state === "playing" ? Math.max(0, (now() - Number(s.updated || now())) / 1000) : 0);
    const to = Math.max(0, Math.min(action === "seek" ? v : Math.round(here + v), Math.max(0, (Number(s.duration) || 0) - 30)));
    const r = await ML().seek(user, R.id, to);
    return { ok: true, action, from: clock_(here), to: clock_(r.position != null ? r.position : to), pad };
  }
  if (action === "next" || action === "prev") {
    const q = await MQ().activeFor(R.id);
    if (!q) {
      if (s) throw new Fail(action === "next" ? "last_title" : "first_title", "That's the only title playing.", 409);
      throw new Fail("nothing_on", "Nothing from the library is playing on this pad.", 404);
    }
    const r = action === "next" ? await MQ().next(user, R.id) : await MQ().prev(user, R.id);
    return { ok: true, action, title: r.title || null, ended: !!r.ended, pad };
  }
  throw new Fail("bad", "Bad control.", 400);
}

async function opNp(user, b) {
  const target = b.target === "cam" ? "cam" : "stage";
  const out = { ok: true, target };
  if (target === "cam") {
    const T = (OA().view() || {}).target || null;
    out.on_air = T ? T.label : null;
    // 1.99akr onairtitle: + the video's title when it's an embed (the label alone said only "🔗 YouTube video")
    const ti = T && OA().titleOf ? OA().titleOf(T) : null;
    out.on_air_title = ti && ti.title ? ti.title : null;     // a held title (onairtitle.vet) is never sent
    return out;
  }
  const R = await padOf(b.room);
  await seeOrFail(user, R);
  const v = await ML().player(user, R.id);
  Object.assign(out, { on: !!v.on, title: v.title || null, state: v.state || null, position: Math.round(Number(v.position) || 0),
                       duration: v.duration || null, by: v.by || null, can_control: !!v.can_control, pad: { id: R.id, title: R.title || R.id } });
  if (v.on && v.state === "playing" && v.at) out.position = Math.round(out.position + Math.max(0, (now() - v.at) / 1000));
  if (v.queue) out.next = v.queue.next && v.queue.next[0] ? ML().fmtTitle(v.queue.next[0]) : null;
  return out;
}

async function opContinue(user, b) {
  const R = await padOf(b.room);
  await seeOrFail(user, R);
  await ML().init();
  const A = await ML()._q.mustAccess(user);
  const show = norm(clean(b.show, 100));
  const rows = await getQuery("SELECT rating_key, title FROM media_plays WHERE user_id = ? AND kind = 'episode' AND ts > ? AND rating_key IS NOT NULL ORDER BY id DESC LIMIT 20",
                              [user.userId, now() - CONTINUE_MS]);
  const hit = rows.find((r) => !show || norm(String(r.title || "").split(" — ")[0]) === show || norm(String(r.title || "")).startsWith(show + " "));
  if (!hit) return { ok: true, row: null };
  const nxt = await MQ().nextEpisodeOf({ type: "episode", key: String(hit.rating_key) });
  if (!nxt) return { ok: true, row: null, last: String(hit.title || "") };
  const S = conf().get();
  const per = A.free ? 0 : Math.max(0, Math.floor(Number(S.library_price) || 0));
  return { ok: true, row: slim({ key: nxt.key, type: "episode", title: nxt.title, show: nxt.show, season: nxt.season, episode: nxt.episode, duration: nxt.duration,
                                 scope: "episode", exact: true, price: per ? ML().priceFor(nxt.duration, 0, S).price : 0,
                                 estimate: per ? MQ().estimate(per, nxt.duration) : 0, label: labelOf(nxt) }),
           free: !!A.free, state: await ML().padState(user, R.id).catch(() => null) };
}

async function opRpm(user, b) {
  const R = await padOf(b.room);
  await seeOrFail(user, R);
  const text = clean(b.text, 400);
  if (!text) throw new Fail("bad", "Nothing to say.", 400);
  require("./bridge-relay").roomPmLocal(user.userId, R.id, text, "plex");
  return { ok: true };
}

// ── the audit trail (1.99ajk plexchat review) ──
/** A play / a control through Pepe -> one media_controls row ("pepe", e.g. "room chat as alice: play 100 -> The Matrix (1999)"): the
 *  pad's "Who did what" list and the site's records say it came from chat, and which login / account asked. Never blocks. */
async function audit(user, b, ctx, op, r) {
  try {
    const room = b.target === "cam" ? rooms().HOUSE_ROOM : (r.pad && r.pad.id) || b.room;
    const how = (ctx.via === "web" ? "web chat" : "room chat") + (ctx.login ? " as " + clean(ctx.login, 40) : "");
    const what = op === "play" ? `${b.target === "cam" ? "cam " : ""}${b.mode === "next" ? "next " : b.mode === "replace" && b.target !== "cam" ? "instead " : ""}play ${clean(b.key, 12)}${r.title ? " -> " + clean(r.title, 80) : ""}`
      : `${clean(b.action, 12)}${b.value != null ? " " + clean(b.value, 12) : ""}`;
    await ML().logControl(user, String(room || ""), "pepe", `${how}: ${what}`.slice(0, 160));
  } catch (e) { /* the log never blocks a play */ }
}

// ── the route ──
const hits = new Map();               // userId -> [ms...] (30 ops a minute per account)
function rateOk(userId, t = now()) {
  const a = (hits.get(userId) || []).filter((x) => t - x < RATE_MS);
  if (a.length >= RATE_MAX) { hits.set(userId, a); return false; }
  a.push(t);
  hits.set(userId, a);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > RATE_MS) hits.delete(k);
  return true;
}

/** The speaker as Pepe named it (before any lookup): "u:<id>" | "l:<login>" | "?" - the first rate limit's key. */
function asKey(as) {
  const a = as && typeof as === "object" ? as : {};
  if (a.user_id != null && String(a.user_id).trim()) return "u:" + String(a.user_id).trim().slice(0, 80);
  if (a.login != null && String(a.login).trim()) return "l:" + String(a.login).trim().toLowerCase().slice(0, 40);
  return "?";
}

/** One bot request (already authenticated) -> the answer body (never throws). */
async function handle(b = {}) {
  const op = String(b.op || "");
  try {
    if (!OPS.has(op)) throw new Fail("bad", "Unknown op.", 400);
    const via = b.via === "web" ? "web" : "room";
    if (!rateOk(asKey(b.as))) throw new Fail("rate", "Too many Plex requests - give it a minute.", 429);
    const user = await resolve(b.as);
    if (!rateOk(user.userId)) throw new Fail("rate", "Too many Plex requests - give it a minute.", 429);
    const ctx = { via, login: b.as && b.as.login ? String(b.as.login) : null };
    let r;
    if (op === "search") r = await opSearch(user, b);
    else if (op === "play") r = await opPlay(user, b, ctx);
    else if (op === "control") r = await opControl(user, b);
    else if (op === "np") r = await opNp(user, b);
    else if (op === "continue") r = await opContinue(user, b);
    else r = await opRpm(user, b);
    if ((op === "play" || op === "control") && r && r.ok) await audit(user, b, ctx, op, r);
    console.log(`[plexchat] ${via} ${user.username}: ${op}${b.action ? " " + clean(b.action, 12) : ""}${b.key ? " " + clean(b.key, 12) : ""} -> ok`);
    return { ...r, user: { username: user.username } };
  } catch (e) {
    const body = failBody(e);
    if (body.code === "error") console.error("[plexchat]", op, e && e.stack ? e.stack : e);
    else console.log(`[plexchat] ${op}: refused ${body.code}`);
    return body;
  }
}

function register(app, { isBotToken } = {}) {
  const parse = express.json({ limit: "16kb" });
  app.post("/api/medialib/bot", parse, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    if (typeof isBotToken !== "function" || !isBotToken(b.password)) return res.status(403).json({ ok: false, code: "auth", error: "unauthorized" });
    res.json(await handle(b));
  });
}

module.exports = { register, handle, resolve, codeOf, failBody, score, norm, asKey, CODES, RATE_MAX,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _hits: hits };
