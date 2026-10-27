// roomstats.js — per-room analytics for the Camfrog rooms Pepe sits in (1.99be).
//
// Pepe keeps the room aggregates and his room knowledge (pepe_roomintel.py in the bot: per-day
// messages / mic / commands / visitors, hour-of-week activity, regulars, commands and games in the
// room, aggregate moderation, recurring topics from periodic summaries) and pushes the rooms that
// changed to POST /api/roomstats/sync (bot token): {rooms: [...], remove: [room ids], tz, days}.
// We keep the latest copy per room and render /p/:slug/analytics (the pad's analytics, 1.99ck).
//
// Pages follow the live room page's rule (bridge.js): signed-in only — visitors get the page shell
// with a sign-in prompt and no data. The slug is the bridged room's slug when the room is bridged,
// else one made from the room's name the same way.
//
// Privacy:
//   * Pepe never sends !incognito users by name (they only count anonymously in the totals), never
//     PMs, never PM/website commands, never who did a moderation action (counts only)
//   * a regular / mic leader whose linked PATV account hides Analytics (or its Rooms panel) on their
//     profile layout is not named here: they're folded into "+N keep their activity private"
//   * room admins can take a room off the site from Camfrog (`!roominfo site off` -> remove[])
//   * 1.99afl (the incognito spec, section K): counting never changes - private people keep their real rank and numbers, shown as
//     "someone" (no name, no link). Pepe 1.99afk sends them as anon rows {anon, h (their hidden-set hash: server-only, never
//     rendered), numbers}; and at render time any row naming a login that is incognito NOW (incognito_state on / incognito_anon)
//     or on the sticky hidden set (!incognito / !bridge hide, both stores - chatlogview.isHiddenLogin, fails closed) is "someone"
//     at its rank too, so a room whose last sync predates someone going private never prints their name. The person themselves
//     (their linked Camfrog login, or an anon row's h) sees "you". Review: a private row shows no last-seen time, and Pepe's
//     free text (notes, "changes", topics over time) names nobody private now either (freeTextScrub, fails closed).
//   * 1.99afn (FU-3, owner 2026-10-27 K-1 / D-12 / D-13): the boards show each private person under a FROG NAME ("Mossy Newt") at
//     their real rank with their EXACT numbers - frognames.boardAliases: one name per person per room per day (it turns at 10:00
//     UTC), the same on both boards, keyed by the hidden-set hash (an anon row's h = chatlog.hash(login) of a masked row); never
//     their chat name, never derivable without ALIAS_SECRET. The view model carries the name only - no login, hash or key. The
//     free text keeps "someone" (D-17: a frog name in a sentence would tie it to a board row). Their own row: "Mossy Newt (you)".
//   * 1.99afn see-through (D-14 / D-15, J-18): admins (chatlog.see_through) on every pad, a pad's owner on their own pad once they
//     have owned it for the whole 90 days the boards cover, can reveal who is behind a frog name - one row (POST .../reveal) or a
//     toggle that stays on until turned off (POST .../seethrough), each one a seethrough_log row; nothing passive (a GET never
//     turns anything on), no-store, no-referrer. Staff, members and other pads' owners: 403, no row.
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const { _render: R } = require("./userstats");
const FN = require("./frognames");
const ST = require("./seethrough");
const guard = require("./middleware/authGuard");

const MAX_ROOMS = 30, DAYS = 90, SUMMARY_MAX = 900;
const ready = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS camfrog_roomstats (
    room_id TEXT PRIMARY KEY, name TEXT, data TEXT NOT NULL, updated INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS camfrog_roomstats_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1), tz TEXT, days INTEGER, updated INTEGER)`);
})().catch((e) => console.error("[roomstats] init:", e));

// ── sanitising ──
const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const str = (v, n) => String(v == null ? "" : v).replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, n);
const int = (v, lo = 0, hi = Number.MAX_SAFE_INTEGER) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const ID_RE = /^[A-Za-z0-9._\-]{1,64}$/;
const LOGIN_RE = /^[\w.\-]{2,40}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-z_]{2,24}$/;
const CMD_RE = /^[a-z0-9_]{1,24}$/;
const arr168 = (a) => Array.from({ length: 168 }, (_, i) => int(Array.isArray(a) ? a[i] : 0));
const counts = (o, n = 40) => {
  const out = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o).slice(0, n)) if (KEY_RE.test(k)) out[k] = int(v);
  return out;
};
const dayMap = (o, fn) => {
  const out = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o).slice(0, DAYS + 10)) if (DAY_RE.test(k)) out[k] = fn(v);
  return out;
};
const strList = (a, n, m) => (Array.isArray(a) ? a : []).slice(0, n).map((x) => str(x, m)).filter(Boolean);
const HASH_RE = /^[0-9a-f]{20}$/;
/** A row's numbers. 1.99afl review: a private row's never include `last` - their last-seen time would track a person the pad
 *  otherwise leaves out ("someone · last seen 3 min ago"); bot 1.99afk's anon rows carry none either. */
const counts3090 = (p) => ({ m30: int(p.m30), s30: int(p.s30), d30: int(p.d30, 0, 31), m90: int(p.m90), s90: int(p.s90), d90: int(p.d90, 0, 91) });
const nums = (p) => Object.assign(counts3090(p), { last: int(p.last) });
const person = (p) => {
  if (!p || typeof p !== "object") return null;
  // 1.99afl (section K): a private person at their real rank - no login, no name, no last-seen time; `h` (their hidden-set hash)
  // only so they can see their own row as "you" (login-equivalent: never rendered, never in a view model)
  if (p.anon === true) return Object.assign({ anon: true }, typeof p.h === "string" && HASH_RE.test(p.h) ? { h: p.h } : {}, counts3090(p));
  const login = str(p.login, 40).toLowerCase();
  if (!LOGIN_RE.test(login)) return null;
  return Object.assign({ login, display: str(String(p.display == null ? "" : p.display).replace(/<[^<>]{0,40}>/g, ""), 40).replace(/[<>]/g, "") || login }, nums(p));
};

function clean(r) {
  if (!r || typeof r !== "object") return null;
  const room = str(r.room, 64);
  if (!ID_RE.test(room) || room === "camfrog") return null;
  const k = r.knowledge && typeof r.knowledge === "object" ? r.knowledge : {};
  const sz = r.size && typeof r.size === "object" ? r.size : {};
  return {
    room, name: str(r.name, 60) || room, first: int(r.first), last: int(r.last),
    days: dayMap(r.days, (v) => ({ m: int(v && v.m), s: int(v && v.s), k: int(v && v.k), u: int(v && v.u), c: int(v && v.c), n: int(v && v.n) })),
    how: arr168(r.how), hows: arr168(r.hows),
    size: { typical: sz.typical == null ? null : int(sz.typical, 0, 5000), peak: sz.peak == null ? null : int(sz.peak, 0, 5000),
            src: sz.src === "roster" ? "roster" : sz.src === "active" ? "active" : null },
    peak: str(r.peak, 80),
    uniq: { d30: int((r.uniq || {}).d30), d90: int((r.uniq || {}).d90) },
    regulars: (Array.isArray(r.regulars) ? r.regulars : []).slice(0, 15).map(person).filter(Boolean),
    mic_top: (Array.isArray(r.mic_top) ? r.mic_top : []).slice(0, 10).map(person).filter(Boolean),
    cmds: {
      top: (Array.isArray((r.cmds || {}).top) ? r.cmds.top : []).slice(0, 15)
        .filter((t) => Array.isArray(t) && CMD_RE.test(String(t[0])) && t[2] !== "moderation")
        .map((t) => [String(t[0]), int(t[1]), KEY_RE.test(String(t[2])) ? String(t[2]) : "utility"]),
      cats: counts((r.cmds || {}).cats, 12),
    },
    games: { days: dayMap((r.games || {}).days, (v) => counts(v, 8)) },
    mod: { total: counts((r.mod || {}).total), days: dayMap((r.mod || {}).days, (v) => counts(v)) },
    knowledge: {
      // 1.99el: was 400 - Pepe's 2-3 sentence notes ran past it and were cut mid-sentence (Pepe capped them at
      // 400 too; he now sends up to 900, ending at a sentence)
      summary: str(k.summary, SUMMARY_MAX), vibe: str(k.vibe, 160), at: int(k.at),
      topics: (Array.isArray(k.topics) ? k.topics : []).slice(0, 10)
        .map((t) => ({ t: str(t && t.t, 60), w: int(t && t.w, 1, 5) || 1 })).filter((t) => t.t),
      jokes: strList(k.jokes, 6, 120), events: strList(k.events, 6, 140), rules: strList(k.rules, 5, 120),
    },
    changes: strList(r.changes, 5, 160),
    history: (Array.isArray(r.history) ? r.history : []).slice(-12)
      .map((h) => ({ at: int(h && h.at), topics: strList(h && h.topics, 6, 60) })).filter((h) => h.at),
  };
}

// ── storage ──
async function all() {
  await ready;
  const rows = await getQuery("SELECT room_id, name, data, updated FROM camfrog_roomstats");
  return rows.map((r) => { try { return Object.assign(JSON.parse(r.data), { updated: r.updated }); } catch (e) { return null; } }).filter(Boolean);
}
async function meta() {
  await ready;
  return (await getQuery("SELECT tz, days, updated FROM camfrog_roomstats_meta WHERE id = 1"))[0] || {};
}

// slugs: a bridged room keeps its live page's slug; others are made from the name the same way
function bridgeMod() { try { return require("./bridge"); } catch (e) { return null; } }
function slugsFor(list) {
  const b = bridgeMod();
  const slugify = (b && b.slugify) || ((s) => String(s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "room");
  const live = new Map();
  if (b && b._rooms) for (const Rm of b._rooms.values()) live.set(Rm.id, Rm.slug);
  const taken = new Set(live.values());
  const out = new Map();
  for (const r of list) {
    let s = live.get(r.room);
    if (!s) {
      s = slugify(r.name);
      if (taken.has(s)) s = slugify(r.room);
      taken.add(s);
    }
    out.set(r.room, s);
  }
  return out;
}

async function bySlug(slug) {
  const list = await all();
  const slugs = slugsFor(list);
  const s = String(slug || "").toLowerCase();
  return list.find((r) => slugs.get(r.room) === s || r.room.toLowerCase() === s) || null;
}

/** [{slug, name, last}] for the rooms list. */
async function listing() {
  const list = await all();
  const slugs = slugsFor(list);
  return list.sort((a, b) => (b.last || 0) - (a.last || 0)).map((r) => ({ slug: slugs.get(r.room), name: r.name, room: r.room }));
}

// ── privacy: who may be named ──
async function privateLogins(logins) {
  const out = new Map();     // login -> {username, display} for linked public profiles; private ones flagged
  const list = [...new Set(logins)].filter((l) => LOGIN_RE.test(l));
  if (!list.length) return out;
  const q = list.map(() => "?").join(",");
  let users = [];
  try {
    // 1.99dt: an archived account's privacy choice still counts, but it's never linked
    const arch = await require("./userlinks").archivedCol();
    users = await getQuery(`SELECT userId, username, displayname, camfrogUsername, ${arch} AS archived_at FROM users WHERE lower(camfrogUsername) IN (${q})`, list);
  } catch (e) { users = []; }
  let pl = null;
  try { pl = require("./profilelayout"); } catch (e) { pl = null; }
  for (const u of users) {
    const login = String(u.camfrogUsername || "").toLowerCase();
    let hidden = false;
    if (pl) {
      try {
        const layout = await pl.get(u.userId);
        hidden = pl.stateOf(layout, "analytics") === "hidden" || pl.stateOf(layout, "an_rooms") === "hidden";
      } catch (e) { hidden = true; }          // fail closed
    }
    const prev = out.get(login);
    if (prev && prev.private) continue;                 // any linked account hiding it keeps the name off
    if (hidden) out.set(login, { private: true });
    else if (u.archived_at == null) out.set(login, { username: u.username });
    else if (!prev) out.set(login, {});                 // archived: named, not linked
  }
  return out;
}

/** 1.99afl (section K): the logins among `logins` that are private NOW - incognito (Pepe's list as the site keeps it:
 *  incognito_state on, incognito_anon - the gtfboards.privateSet rule) or on the sticky hidden set (!incognito / !bridge hide,
 *  either store: chatlogview.isHiddenLogin - fails closed while it loads). They show as "someone" at their rank. A check that
 *  can't run counts as private (nobody is named on a guess). */
async function maskedLogins(logins) {
  const list = [...new Set(logins)].filter((l) => LOGIN_RE.test(l));
  const out = new Set();
  if (!list.length) return out;
  const want = new Set(list);
  for (const sql of [`SELECT login FROM incognito_state WHERE "on" = 1`, "SELECT login FROM incognito_anon"]) {
    try { for (const r of await getQuery(sql)) { const l = String(r.login || "").toLowerCase(); if (want.has(l)) out.add(l); } }
    catch (e) { if (!/no such table/i.test(String(e && e.message))) for (const l of list) out.add(l); }
  }
  let CV = null;
  try { CV = require("./chatlogview"); await CV.init(); } catch (e) { CV = null; }
  for (const l of list) {
    if (out.has(l)) continue;
    let hid = true;
    try { hid = !CV || !!CV.isHiddenLogin(l); } catch (e) { hid = true; }
    if (hid) out.add(l);
  }
  return out;
}
/** Every login incognito now (incognito_state on, incognito_anon); a store that can't be read throws (no such table: none). */
async function incognitoLogins() {
  const out = new Set();
  for (const sql of [`SELECT login FROM incognito_state WHERE "on" = 1`, "SELECT login FROM incognito_anon"]) {
    try { for (const r of await getQuery(sql)) { const l = String(r.login || "").trim().toLowerCase(); if (LOGIN_RE.test(l)) out.add(l); } }
    catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
  }
  return out;
}
/**
 * 1.99afl review (section K): Pepe's FREE TEXT on the analytics page - the room notes (summary, vibe, topics, jokes, events,
 * rules), "changes" ("new regulars: ...", "seen less lately: ...") and the topics over time - can name people who are private
 * NOW: it is stored as Pepe last sent it, and a room he isn't in is never synced again (DRAMA_CENTRAL's public page printed four
 * incognito people that way). -> s => s with every private person's names as "someone", at render time:
 *   - chatlogview.redact: everyone incognito / hidden now in either sticky store - their login and the display names the
 *     hidden-names job knows (>= 3 characters, its stop-list kept);
 *   - plus the names private people (maskedLogins: incognito now, or hidden) go by in ANY room's rows here (a regular's / mic
 *     leader's login and display name - "*Mephobia*" from another room's mic board) and every incognito login.
 * Fails closed: when either can't run, the free text is left out ("").
 * 1.99afn (FU-3a, checked): + the people behind THIS page's anon rows (anonHashes). Pepe sends a row anonymous only for someone
 * private on his side (!incognito / !bridge hide), so whoever the site can put to such a hash (loginsForHashes, cached) is scrubbed
 * from the text too - with every name they go by in the stored rows - even when they are on none of the site's own lists.
 */
async function freeTextScrub(anonHashes = []) {
  let CV;
  try { CV = require("./chatlogview"); await CV.init(); } catch (e) { return () => ""; }
  let extra = null;
  try {
    const names = new Map();                          // login -> Set(names it goes by in the stored rows)
    const add = (l, n) => { if (!names.has(l)) names.set(l, new Set([l])); if (n) names.get(l).add(String(n)); };
    for (const r of await all()) {
      for (const p of [...(r.regulars || []), ...(r.mic_top || [])]) if (p && !p.anon && LOGIN_RE.test(String(p.login || ""))) add(p.login, p.display);
    }
    for (const l of await incognitoLogins()) add(l, null);
    const anonLogins = new Set((await cachedLogins(anonHashes)).values());
    for (const l of anonLogins) add(l, null);
    const priv = await maskedLogins([...names.keys()]);
    for (const l of anonLogins) priv.add(l);
    const terms = new Set();
    for (const l of priv) {
      for (const n of names.get(l) || []) {
        const s = String(n).replace(/^@+/, "").trim();
        if (Array.from(s).length >= 3 && !CV.STOP.has(s.toLowerCase())) terms.add(s.toLowerCase());
      }
    }
    extra = terms.size ? new RegExp("(?<![\\p{L}\\p{N}_])@?(?:" + CV.trieSource([...terms]) + ")(?![\\p{L}\\p{N}_])", "giu") : null;
  } catch (e) {
    console.error("[roomstats] private names:", e && e.message);
    return () => "";
  }
  return (s) => {
    if (typeof s !== "string" || !s) return "";
    const o = CV.redact(s);
    return extra ? o.replace(extra, "someone") : o;
  };
}
/** loginsForHashes with a 10-minute memory per hash (found or not) - the page's free-text scrub asks on every render. */
const H2L = new Map(), H2L_TTL = 10 * 60e3;
async function cachedLogins(hs) {
  const t = Date.now(), out = new Map(), miss = [];
  for (const h of new Set((hs || []).filter((x) => HASH_RE.test(String(x || ""))))) {
    const c = H2L.get(h);
    if (c && t - c.at < H2L_TTL) { if (c.l) out.set(h, c.l); } else miss.push(h);
  }
  if (miss.length) {
    const got = await loginsForHashes(miss);
    for (const h of miss) { const l = got.get(h) || null; H2L.set(h, { l, at: t }); if (l) out.set(h, l); }
    while (H2L.size > 5000) H2L.delete(H2L.keys().next().value);
  }
  return out;
}
/** The viewer's own linked Camfrog login (lower case) or null. */
async function viewerLogin(userId) {
  if (!userId) return null;
  try {
    const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
    const l = r && r.camfrogUsername ? String(r.camfrogUsername).trim().toLowerCase() : "";
    return LOGIN_RE.test(l) ? l : null;
  } catch (e) { return null; }
}
const hiddenHash = (login) => { try { return require("./chatlog").hash(login); } catch (e) { return null; } };

// ── 1.99afn (FU-3): the boards' private rows - frog names, and see-through on demand ──
const OWNER_ERA_MS = DAYS * 864e5;        // D-15: a pad's owner reveals only once they have owned it for the whole board (90 days)
const SEE_LINE = "analytics_line", SEE_TOGGLE = "analytics_toggle";     // seethrough.js scopes
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
/**
 * The two boards, shaped - SERVER SIDE. A named row as before (+ href); a private row (Pepe's anon row, or a login private now)
 * {anon, you, key, login (a masked named row's - else null), alias, numbers}: key (its hidden-set hash) and login never leave this
 * module except through a logged reveal. One frog-name map for both boards (a person has one name on the page). viewer = {userId}.
 */
async function boards(r, viewer, t = Date.now()) {
  const people = [...(r.regulars || []), ...(r.mic_top || [])].filter((p) => p && !p.anon && p.login);
  const priv = await privateLogins(people.map((p) => p.login));
  const masked = await maskedLogins(people.map((p) => p.login));
  const me = viewer && viewer.userId ? await viewerLogin(viewer.userId) : null;
  const meH = me ? hiddenHash(me) : null;
  const avoid = [];
  const mark = (list, board) => {
    const shown = [];
    let hidden = 0;
    (list || []).forEach((p, i) => {
      if (!p) return;
      if (p.anon || masked.has(p.login)) {
        const you = !!me && (p.anon ? !!meH && p.h === meH : p.login === me);
        // (the numbers only on the page - never the login, the name, the hash or (review) the last-seen time)
        const key = p.anon ? (p.h || `${board}:${i}`) : (hiddenHash(p.login) || `${board}:${i}`);
        shown.push(Object.assign(counts3090(p), { anon: true, you, key, h: p.anon && p.h ? p.h : null, login: p.anon ? null : p.login }));
        return;
      }
      avoid.push(p.login, p.display);
      const a = priv.get(p.login);
      if (a && a.private) { hidden++; return; }
      shown.push({ ...p, href: a && a.username ? `/u/${encodeURIComponent(a.username)}` : null });
    });
    return { shown, hidden };
  };
  const regs = mark(r.regulars, "r"), mics = mark(r.mic_top, "m");
  const anon = [...regs.shown, ...mics.shown].filter((p) => p.anon);
  const names = FN.boardAliases(r.room, FN.boardPeriod(t), anon.map((p) => p.key), avoid);
  for (const p of anon) p.alias = names.get(p.key) || "someone";
  return { regs, mics };
}
/** h -> login, for a logged reveal only: chatlogview's names (the hidden-names job, the who map), everyone incognito now, every
 *  linked Camfrog login, every login Pepe sent stats for - each checked by hashing it back. -> Map(h -> login) */
async function loginsForHashes(hs) {
  const want = new Set((hs || []).filter((h) => HASH_RE.test(String(h || ""))));
  const out = new Map();
  const tryLogin = (l) => { const x = low(l); if (!LOGIN_RE.test(x)) return; const h = hiddenHash(x); if (h && want.has(h) && !out.has(h)) out.set(h, x); };
  if (!want.size) return out;
  try { const CV = require("./chatlogview"); for (const h of want) { const l = await CV.loginForHash(h); if (l) tryLogin(l); } } catch (e) { /* the tables below */ }
  const sources = [async () => [...(await incognitoLogins())], async () => (await getQuery("SELECT camfrogUsername AS l FROM users WHERE camfrogUsername IS NOT NULL")).map((x) => x.l),
                   async () => (await getQuery("SELECT login AS l FROM camfrog_userstats")).map((x) => x.l)];
  for (const src of sources) {
    if (out.size >= want.size) break;
    try { for (const l of await src()) tryLogin(l); } catch (e) { /* a store that isn't there */ }
  }
  return out;
}
/** The real login behind each private row (null = the site doesn't know it). -> Map(key -> login | null) */
async function realLogins(rows) {
  const priv = (rows || []).filter((p) => p && p.anon);
  const byH = await loginsForHashes(priv.filter((p) => !p.login && p.h).map((p) => p.h));
  const out = new Map();
  for (const p of priv) out.set(p.key, p.login || (p.h && byH.get(p.h)) || null);
  return out;
}
/** D-15: has userId owned pad roomId for the whole board? The chat archive's owner era (chatlog_rooms.owner_since) and the pad's
 *  last owner change (room_events 'owner') - the LATER one counts, and it must be >= 90 days back. No row: no.
 *  Review fixes (1.99afn): chatlog_rooms.owner_grant is NOT read - it is CL6's "the owner may read the earlier chat era" grant,
 *  which any Staff member can set (chatlogmod.ownerGrant), and Staff have no see-through (J-2), so they can't hand it out either.
 *  owner_since = 0 is the archive's "first owner seen" value (chatlog.rkInTx), not "owner since 1970": with no 'owner' event to
 *  date the ownership it fails closed (no). */
async function ownerEraCovers(roomId, userId, t) {
  const row = (await getQuery("SELECT owner_id, owner_since FROM chatlog_rooms WHERE room_id = ?", [String(roomId)]))[0];
  if (!row || String(row.owner_id || "") !== String(userId)) return false;
  const ev = (await getQuery("SELECT MAX(ts) AS ts FROM room_events WHERE room_id = ? AND what = 'owner'", [String(roomId)]))[0];
  const evTs = ev && ev.ts != null ? Number(ev.ts) || 0 : 0;
  const since = Math.max(Number(row.owner_since) || 0, evTs);
  if (!(since > 0)) return false;                              // nothing dates the ownership: fail closed
  return since <= t - OWNER_ERA_MS;
}
/** Who may reveal frog names on pad padId: "admin" (chatlog.see_through, every pad) | "owner" (their own pad, D-15) | null. A check
 *  that can't run says null. Staff never: the capability is Admin-only and locked. */
async function seeThroughRole(user, padId, t = Date.now()) {
  if (!user || !user.userId) return null;
  try { if (await require("./siteperms").canId(user.userId, "chatlog.see_through")) return "admin"; } catch (e) { return null; }
  try {
    const pad = await require("./rooms").get(padId);
    if (!pad || !pad.owner || String(pad.owner.userId) !== String(user.userId)) return null;
    return (await ownerEraCovers(padId, user.userId, t)) ? "owner" : null;
  } catch (e) { return null; }
}

// ── rendering helpers ──
const DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const GAME = { heists: ["Heists & GTF", "#ef5350"], casino: ["Casino (blackjack / hold'em)", "#4caf50"], wheel: ["Wheel spins", "#ffd54f"],
               lotto: ["Lotto & bingo", "#4fc3f7"], games: ["Other games", "#ba68c8"] };
const MODL = { kick: "Kicks", ban: "Bans", mute: "Mutes", mic_block: "Mic blocks", demote: "Demotions", fine: "Fines", warning: "Warnings",
               mic_unblock: "Mic unblocks", unmute: "Unmutes", unban: "Unbans", promote: "Promotions", topic: "Topic changes",
               strike: "Automod strikes", michog_strike: "Mic-hog strikes", timeout: "Time-outs", demoted: "Automod demotions",
               suspension: "Red-list suspensions" };
const CAT = { games: ["Games & casino", "#4caf50"], heists: ["Heists & GTF", "#ef5350"], economy: ["Economy", "#ffd54f"],
              music: ["Music", "#4fc3f7"], media: ["Cams & media", "#ba68c8"], ai: ["AI & chat", "#81c784"],
              utility: ["Utility", "#90a4ae"], moderation: ["Moderation & admin", "#ff8a65"] };

/** 7x24 hour-of-week heatmap (one shared scale), HTML cells. */
function weekHeat(arr, rgb, fmtV) {
  const max = Math.max(...arr, 0);
  let rows = "";
  for (let d = 0; d < 7; d++) {
    let cells = "";
    for (let h = 0; h < 24; h++) {
      const v = arr[d * 24 + h] || 0;
      const a = max ? 0.08 + 0.92 * Math.pow(v / max, 1.6) : 0;   // steeper than the profile strip: rooms are busy around the clock
      const tip = `${DAYS_SHORT[d]} ${String(h).padStart(2, "0")}:00 · ${fmtV(v)}`;
      cells += `<span class="ra-cell" style="background:${v ? `rgba(${rgb},${a.toFixed(2)})` : "#191919"}" data-tip="${R.esc(tip)}" title="${R.esc(tip)}"></span>`;
    }
    rows += `<div class="ra-hrow"><span class="ra-hname">${DAYS_SHORT[d]}</span><div class="ra-cells">${cells}</div></div>`;
  }
  return rows;
}

/** Visitors per day: returning (dim) + new (bright) stacked, same frame as userstats' bar charts. */
function visitorsChart(axis, days) {
  const W = axis.length * 8, H = 100;
  const vals = axis.map((k) => days[k] || { u: 0, n: 0 });
  const max = R.niceMax(Math.max(...vals.map((v) => v.u), 0) || 1);
  let bars = "", hits = "", xl = "";
  axis.forEach((k, i) => {
    const v = vals[i], x = i * 8 + 1;
    const ret = Math.max(0, v.u - v.n);
    const tip = `${R.dayLabel(k)} · ${R.fmt(v.u)} visitor${v.u === 1 ? "" : "s"} (${R.fmt(v.n)} new)`;
    if (v.u > 0) {
      const hr = (ret / max) * H, hn = (v.n / max) * H;
      if (ret) bars += `<rect x="${x}" y="${(H - hr).toFixed(2)}" width="6" height="${Math.max(1.5, hr).toFixed(2)}" rx="1.5" fill="#5c6bc0"/>`;
      if (v.n) bars += `<rect x="${x}" y="${(H - hr - hn).toFixed(2)}" width="6" height="${Math.max(1.5, hn).toFixed(2)}" rx="1.5" fill="#26c6da"/>`;
    }
    hits += `<rect x="${i * 8}" y="0" width="8" height="${H}" class="ua-hit" data-tip="${R.esc(tip)}"><title>${R.esc(tip)}</title></rect>`;
    if ((i % 15 === 0 && axis.length - 1 - i >= 14) || i === axis.length - 1) {
      xl += `<span style="left:${(((i * 8 + 4) / W) * 100).toFixed(2)}%"${i === axis.length - 1 ? ' class="end"' : ""}>${R.esc(R.dayLabel(k))}</span>`;
    }
  });
  const yl = [1, 0.5].map((f) => `<span style="top:${((1 - f) * 100).toFixed(0)}%">${R.esc(R.fmt(max * f))}</span>`).join("");
  const grid = [0, 0.5].map((f) => `<line x1="0" x2="${W}" y1="${f * H}" y2="${f * H}" class="ua-grid"/>`).join("")
    + `<line x1="0" x2="${W}" y1="${H}" y2="${H}" class="ua-base"/>`;
  return `<div class="ua-bars"><div class="ua-yl" aria-hidden="true">${yl}</div>`
    + `<svg class="ua-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Unique visitors per day, new and returning">${grid}${bars}${hits}</svg>`
    + `<div class="ua-xl" aria-hidden="true">${xl}</div></div>`;
}

const sumDays = (days, k0, f) => Object.entries(days || {}).filter(([k]) => k >= k0).reduce((a, [, v]) => a + f(v), 0);

// 1.99el: Pepe's summary ends at a full sentence. Notes stored before 1.99el were cut at 400 characters
// mid-sentence ("...The earlier bot-building/heist crowd was a"): show them up to their last full sentence.
const SENT_END = /[.!?…]["'”’)\]]*(?=\s|$)/g;
const SENT_TAIL = /[.!?…]["'”’)\]]*$/;
const SOFT_TAIL = /[\s,;:\-—]+$/;
const LEGACY_CAP = 400;            // what notes were cut at before 1.99el
function sentenceTrim(text, max = SUMMARY_MAX) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  // shorter than the old 400 cap (399 = a cut that landed on a space, which was stripped) and within the limit:
  // never cut, shown as written
  if (s.length < LEGACY_CAP - 1 && s.length <= max) return s;
  if (s.length <= max && SENT_TAIL.test(s)) return s;
  const head = s.slice(0, max);
  let end = -1, m;
  SENT_END.lastIndex = 0;
  while ((m = SENT_END.exec(head))) end = m.index + m[0].length;
  if (end >= Math.min(40, Math.floor(head.length / 3))) return head.slice(0, end).trim();
  // no full sentence to fall back to: cut at a word and say so
  const cut = s.length <= max ? s : (head.includes(" ") ? head.slice(0, head.lastIndexOf(" ")) : head);
  return cut.replace(SOFT_TAIL, "") + "…";
}

// 1.99el: "Topics over time" snapshots are ~6 hours apart, so a date alone repeated ("Oct 7, 2026" twice). Each
// label carries the hour, in the timezone the page states (Pepe sends a Windows zone name such as "Eastern
// Daylight Time"); an unknown zone falls back to UTC and says so. The year only when it isn't this year.
const TZ_MAP = [[/^(us )?eastern (standard|daylight|summer)? ?time$|^E[SD]T$/i, "America/New_York"],
                [/^(us )?central (standard|daylight|summer)? ?time$|^C[SD]T$/i, "America/Chicago"],
                [/^(us )?mountain (standard|daylight|summer)? ?time$|^M[SD]T$/i, "America/Denver"],
                [/^(us )?pacific (standard|daylight|summer)? ?time$|^P[SD]T$/i, "America/Los_Angeles"],
                [/^(gmt standard|british summer|gmt daylight) time$|^BST$/i, "Europe/London"],
                [/^(utc|gmt|coordinated universal time)$/i, "UTC"]];
function ianaZone(tz) {
  const t = String(tz || "").trim();
  if (!t) return null;
  for (const [re, z] of TZ_MAP) if (re.test(t)) return z;      // Windows names / US abbreviations first ("EST" is a fixed offset in IANA)
  if (!t.includes("/")) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: t }); return t; } catch (e) { return null; }
}
function histWhen(ts, tz, now = Date.now()) {
  if (!ts) return "—";
  const zone = ianaZone(tz);
  const parts = (d, o) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone || "UTC", ...o })
    .formatToParts(d).map((p) => [p.type, p.value]));
  const d = new Date(ts * 1000);
  const p = parts(d, { month: "short", day: "numeric", year: "numeric", hour: "numeric", hour12: true });
  const thisYear = parts(new Date(now), { year: "numeric" }).year;
  return `${p.month} ${p.day}${p.year !== thisYear ? ", " + p.year : ""} · ${p.hour} ${p.dayPeriod}${zone ? "" : " UTC"}`;
}

/** The day axis and the 30-day headline numbers - shared by the analytics page and the pad About card. */
function headline(r) {
  const today = new Date().toISOString().slice(0, 10);
  const latest = Object.keys(r.days || {}).sort().pop();
  const axis = R.dayAxis(latest && latest > today ? latest : today, DAYS);
  const d30 = axis[axis.length - 30], prev30 = axis[axis.length - 60];
  const days = r.days || {};
  const msgs30 = sumDays(days, d30, (v) => v.m);
  const msgsPrev = Object.entries(days).filter(([k]) => k >= prev30 && k < d30).reduce((a, [, v]) => a + v.m, 0);
  return {
    axis, d30,
    tiles: {
      msgs30: R.fmt(msgs30), msgsTrend: msgsPrev > 50 ? Math.round(((msgs30 - msgsPrev) / msgsPrev) * 100) : null,
      mic30: R.dur(sumDays(days, d30, (v) => v.s)),
      uniq30: R.fmt((r.uniq || {}).d30 || 0),
      typical: r.size && r.size.typical != null ? R.fmt(r.size.typical) : "—",
      typicalNote: r.size && r.size.src === "roster" ? "people in the room" : "people around per hour",
      peakSize: r.size && r.size.peak != null ? R.fmt(r.size.peak) : null,
      peak: r.peak || "—",
    },
  };
}

// 1.99el: the pad About tab's Analytics card - the headline tiles only (no people, no charts), cached per room
// until Pepe's next sync for it (or 5 minutes), so a pad page view costs a Map lookup.
const PREVIEW_TTL = 5 * 60 * 1000;
const previewCache = new Map();
function preview(r) {
  if (!r) return null;
  const key = r.room, hit = previewCache.get(key);
  if (hit && hit.updated === r.updated && Date.now() - hit.at < PREVIEW_TTL) return hit.v;
  const t = headline(r).tiles;
  const v = { msgs30: t.msgs30, msgsTrend: t.msgsTrend, uniq30: t.uniq30, mic30: t.mic30, typical: t.typical,
              typicalNote: t.typicalNote, peakSize: t.peakSize, peak: t.peak };
  previewCache.set(key, { at: Date.now(), updated: r.updated, v });
  if (previewCache.size > MAX_ROOMS * 2) previewCache.delete(previewCache.keys().next().value);
  return v;
}

/** The analytics page's view model. viewer (1.99afl) = {userId} of the signed-in viewer, or null: their own private row is marked
 *  "you". 1.99afn: opts.reveal = the viewer's see-through toggle is on (they may - the route checked): private rows also carry
 *  their real login (`real`, null when the site doesn't know it); opts.see = {role, on} for the page's see-through controls. */
async function forRoom(r, slug, viewer = null, opts = {}) {
  const md = await meta().catch(() => ({}));
  const hl = headline(r);
  const axis = hl.axis, d30 = hl.d30, d90 = axis[0];
  const days = r.days || {};
  // people: privacy per linked PATV account; 1.99afl / 1.99afn: incognito / hidden people at their real rank under a frog name
  const { regs, mics } = await boards(r, viewer);
  const real = opts.reveal ? await realLogins([...regs.shown, ...mics.shown]) : null;
  // a private row in the view model: its frog name, "you", and (toggle on) the real login - never its key, hash or login otherwise
  const privOf = (p) => (p.anon ? { anon: true, you: !!p.you, ...(real ? { revealed: true, real: real.get(p.key) || null } : {}) } : {});
  const micMax = Math.max(1, ...mics.shown.map((p) => p.s90));
  // games per group (30 / 90 days)
  const games = {};
  for (const [day, g] of Object.entries((r.games || {}).days || {})) {
    for (const [k, n] of Object.entries(g)) {
      const e = games[k] || (games[k] = { d30: 0, d90: 0 });
      if (day >= d90) e.d90 += n;
      if (day >= d30) e.d30 += n;
    }
  }
  const gameRows = Object.keys(GAME).filter((k) => games[k] && games[k].d90).map((k) => ({
    key: k, label: GAME[k][0], color: GAME[k][1], d30: R.fmt(games[k].d30), d90: R.fmt(games[k].d90) }));
  // moderation (aggregate, 90 days)
  const mod90 = {};
  for (const [day, m] of Object.entries((r.mod || {}).days || {})) if (day >= d90) for (const [k, n] of Object.entries(m)) mod90[k] = (mod90[k] || 0) + n;
  const modRows = Object.entries(mod90).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: MODL[k] || k, n: R.fmt(n) }));
  // commands
  const top = r.cmds.top.slice(0, 10);
  const cmax = top.length ? top[0][1] : 1;
  const cats = Object.entries(r.cmds.cats || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const catSum = cats.reduce((a, [, n]) => a + n, 0) || 1;
  // growth: new vs returning
  const new30 = sumDays(days, d30, (v) => v.n), new90 = sumDays(days, d90, (v) => v.n);
  const visitorDays30 = sumDays(days, d30, (v) => v.u);
  const avgVisitors = Math.round(visitorDays30 / 30);
  const how = r.how || [], hows = r.hows || [];
  const k = r.knowledge || {};
  // 1.99afl review (section K): Pepe's free text names nobody private now (freeTextScrub; fails closed: left out)
  const scrub = await freeTextScrub([...regs.shown, ...mics.shown].filter((p) => p.anon && p.h).map((p) => p.h));
  const scrubList = (a) => (Array.isArray(a) ? a : []).map(scrub).filter(Boolean);
  const topics = (k.topics || []).map((t) => ({ t: scrub(t.t), w: t.w })).filter((t) => t.t);
  const wmax = Math.max(1, ...topics.map((t) => t.w));
  const summary = scrub(sentenceTrim(k.summary));
  return {
    name: r.name, slug, tz: md.tz || "", updated: r.updated ? R.ago(Math.floor(r.updated / 1000)) : null,
    tiles: {
      ...hl.tiles, cmds30: R.fmt(sumDays(days, d30, (v) => v.k)),
      avgVisitors: R.fmt(avgVisitors), new30: R.fmt(new30), new90: R.fmt(new90),
      returning30: R.fmt(Math.max(0, ((r.uniq || {}).d30 || 0) - new30)),
      uniq90: R.fmt((r.uniq || {}).d90 || 0),
      first: R.dateOf(r.first), last: R.ago(r.last),
    },
    msgChart: R.barChart(axis, Object.fromEntries(Object.entries(days).map(([d, v]) => [d, v.m])), { color: "#4caf50", label: "Messages per day",
      fmtV: (v) => `${R.fmt(v)} message${v === 1 ? "" : "s"}`, unit: (v) => R.fmt(v) }),
    micChart: R.barChart(axis, Object.fromEntries(Object.entries(days).map(([d, v]) => [d, v.s / 60])), { color: "#ffb74d", label: "Mic minutes per day",
      fmtV: (v) => R.dur(v * 60), unit: (v) => `${R.fmt(v)}m` }),
    visitorsChart: visitorsChart(axis, days),
    hasMsgs: Object.values(days).some((v) => v.m), hasMic: Object.values(days).some((v) => v.s),
    heatChat: weekHeat(how, "76,175,80", (v) => `${R.fmt(v)} msgs`),
    heatMic: weekHeat(hows, "255,183,77", (v) => R.dur(v)),
    hasHeatMic: hows.some((v) => v > 0),
    regulars: regs.shown.map((p, i) => ({ rank: i + 1, name: p.anon ? p.alias : p.display, href: p.anon ? null : p.href, d30: p.d30, m30: R.fmt(p.m30),
                                           mic30: p.s30 ? R.dur(p.s30) : "—", d90: p.d90, last: p.anon ? "—" : R.ago(p.last), ...privOf(p) })),
    regularsHidden: regs.hidden,
    mic: mics.shown.map((p, i) => ({ rank: i + 1, name: p.anon ? p.alias : p.display, href: p.anon ? null : p.href, dur: R.dur(p.s90), days: p.d90,
                                     pct: Math.max(3, (p.s90 / micMax) * 100), ...privOf(p) })),
    micHidden: mics.hidden,
    // 1.99afn: any private row on the page (the frog-name footnote, the see-through controls); the controls only for a viewer who may
    hasPrivate: [...regs.shown, ...mics.shown].some((p) => p.anon),
    see: opts.see && (opts.see.on || [...regs.shown, ...mics.shown].some((p) => p.anon)) ? { role: opts.see.role, on: !!opts.see.on } : null,
    cmds: top.map(([c, n, cat]) => ({ cmd: "!" + c, n: R.fmt(n), pct: Math.max(3, (n / cmax) * 100), color: (CAT[cat] || [0, "#90a4ae"])[1], cat: (CAT[cat] || [cat])[0] })),
    cats: cats.map(([c, n]) => ({ label: (CAT[c] || [c])[0], color: (CAT[c] || [0, "#90a4ae"])[1], n: R.fmt(n), pct: (n / catSum) * 100 })),
    games: gameRows, mod: modRows, modTotal: R.fmt(Object.values(mod90).reduce((a, b) => a + b, 0)),
    know: {
      has: !!(summary || topics.length), summary, vibe: scrub(k.vibe || ""),
      at: k.at ? R.ago(k.at) : null,
      topics: topics.map((t) => ({ t: t.t, w: t.w, size: (0.85 + 0.45 * (t.w / wmax)).toFixed(2) })),
      jokes: scrubList(k.jokes), events: scrubList(k.events), rules: scrubList(k.rules),
    },
    changes: scrubList(r.changes),
    history: (r.history || []).slice(-8).reverse().map((h) => ({ when: histWhen(h.at, md.tz), topics: scrubList(h.topics) })),
  };
}

// ── routes ──
function register(app, { isBotToken, addUser }) {
  // A few rooms with 90 days each can pass express.json()'s default 100kb — index.js lets this path
  // through to the larger parser here.
  app.post("/api/roomstats/sync", express.json({ limit: "2mb" }), async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    try {
      await ready;
      const now = Date.now();
      let saved = 0, removed = 0;
      for (const id of (Array.isArray(body.remove) ? body.remove : []).slice(0, MAX_ROOMS)) {
        const rid = str(id, 64);
        if (!ID_RE.test(rid)) continue;
        await runQuery("DELETE FROM camfrog_roomstats WHERE room_id = ?", [rid]);
        removed++;
      }
      for (const r of (Array.isArray(body.rooms) ? body.rooms : []).slice(0, MAX_ROOMS)) {
        const row = clean(r);
        if (!row) continue;
        await runQuery(`INSERT INTO camfrog_roomstats (room_id, name, data, updated) VALUES (?, ?, ?, ?)
                        ON CONFLICT(room_id) DO UPDATE SET name = excluded.name, data = excluded.data, updated = excluded.updated`,
          [row.room, row.name, JSON.stringify(row), now]);
        saved++;
      }
      await runQuery(`INSERT INTO camfrog_roomstats_meta (id, tz, days, updated) VALUES (1, ?, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET tz = excluded.tz, days = excluded.days, updated = excluded.updated`,
        [str(body.tz, 60), int(body.days, 1, 365) || DAYS, now]);
      res.json({ success: true, saved, removed });
    } catch (e) {
      console.error("[roomstats] sync:", e);
      res.status(500).json({ success: false, error: "sync failed" });
    }
  });

  // Registered BEFORE bridge.js's pages: hand the pad page its analytics link (1.99ed: /p no longer lists
  // every pad's analytics - a pad's About tab and header menu link it).
  app.get("/p/:slug", async (req, res, next) => {
    try {
      const r = await bySlug(req.params.slug);
      res.locals.roomAnalytics = r ? `/p/${encodeURIComponent(String(req.params.slug).toLowerCase())}/analytics` : null;
      // 1.99el: the About tab's Analytics card (cached headline numbers). Like the analytics page, the template
      // only prints them for a signed-in viewer (bridge.js's signedIn); others get the same sign-in prompt
      res.locals.roomAnalyticsCard = r ? { stats: preview(r) } : null;
    } catch (e) { res.locals.roomAnalytics = null; res.locals.roomAnalyticsCard = null; }
    next();
  });

  /** The analytics page's room and pad for a request, with the page's own gates (an Approved pad's outsiders: 404; members-tier:
   *  padaccess.full). -> {r, slug, padId, open, approved} or null (the 404 / "no analytics" answer is the caller's) */
  async function padFor(req) {
    let r = null;
    try { r = await bySlug(req.params.slug); } catch (e) { r = null; }
    if (!r) return null;
    const slug = String(req.params.slug).toLowerCase();
    let pad = null;
    try { pad = await require("./roomsweb").resolveRoom(slug); } catch (e) { pad = null; }
    const PA = require("./padaccess");
    await PA.init();
    const padId = pad ? pad.id : r.room;
    if (PA.isApproved(padId) && !PA.canSee(req.user, padId)) return { r, slug, padId, hidden: true };
    return { r, slug, padId, open: PA.full(req.user, padId), approved: PA.isApproved(padId) };
  }

  app.get("/p/:slug/analytics", addUser, async (req, res) => {
    const user = req.user ? req.user.username : null;
    const ctx = await padFor(req).catch(() => null);
    if (!ctx) {
      return res.status(404).render("notFound", { user, heading: "No analytics for that pad",
        message: "Pepe hasn't sent analytics for that pad's Camfrog room (yet).", title: "Pad not found" });
    }
    const { r, slug, padId, open } = ctx;
    res.set("Cache-Control", "private, no-store");
    // 1.99fu: analytics are members-tier (padaccess.full): signed in, or anyone on a Public pad (an Approved pad's
    // outsiders never get here - padaccess.js's page gate)
    if (ctx.hidden) {      // any other address of the same room
      return res.status(404).render("notFound", { user, heading: "No analytics for that pad", message: "There's nothing here.", title: "Pad not found" });
    }
    if (ctx.approved) res.set("X-Robots-Tag", "noindex");
    let a = null;
    if (open) {
      const viewer = req.user && req.user.userId ? { userId: req.user.userId } : null;
      // 1.99afn see-through: only a viewer who may (admin / this pad's owner after 90 days) gets the controls; their toggle shows
      // real names (each page drawn while it is on counts on its log row). Someone who lost the right has their toggle closed.
      let see = null;
      if (viewer) {
        try {
          const role = await seeThroughRole(req.user, padId);
          const tg = await ST.toggleOf(viewer.userId, SEE_TOGGLE, padId);
          if (role) see = { role, on: !!tg, logId: tg ? tg.log_id : null };
          else if (tg) await ST.toggleOff({ userId: viewer.userId, scope: SEE_TOGGLE, roomId: padId, why: "lost_right" });
        } catch (e) { console.error("[roomstats] see-through:", e.message); see = null; }
      }
      try { a = await forRoom(r, slug, viewer, { reveal: !!(see && see.on), see }); } catch (e) { console.error("[roomstats] view:", e); a = null; }
      if (a && see && see.on) {
        res.set("Referrer-Policy", "no-referrer");
        const shown = [...a.regulars, ...a.mic].filter((x) => x.revealed && x.real).map((x) => x.real);
        try { await ST.toggleUsed(see.logId, shown); } catch (e) { console.error("[roomstats] see-through log:", e.message); a = null; }   // not logged: not shown
      }
    }
    let bridged = false;
    try { const b = bridgeMod(); bridged = !!(b && b._rooms && [...b._rooms.values()].some((x) => x.id === r.room)); } catch (e) { bridged = false; }
    res.render("room-analytics", { user, signedIn: open, room: { name: r.name, slug, bridged }, a });
  });

  // 1.99afn see-through (owner J-18 adapted: a row, or a toggle that stays on until turned off) - fetch-only POSTs from this site;
  // never a GET: a link can't reveal anything or write a log row
  const NOPE = "Only PATV admins - and a pad's owner, on their own pad once they have owned it for the 90 days the boards cover - can see who is behind a frog name.";
  // needRole = false: turning the toggle OFF. Review fix: that needs neither the right nor the same-origin check - it only ever
  // shows less, and the page it comes from is served with Referrer-Policy: no-referrer, which some browsers answer with
  // "Origin: null" on a POST (authGuard.originState): a strict check there could leave real names on with no way to hide them.
  // (The page's fetches also ask for referrerPolicy "same-origin", so a same-site Referer / Origin goes along where it can.)
  async function seeCtx(req, res, needRole = true) {
    res.set("Cache-Control", "private, no-store");
    res.set("Referrer-Policy", "no-referrer");
    if (needRole && !guard.sameOriginFetch(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return null; }
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const ctx = await padFor(req).catch(() => null);
    if (!ctx || ctx.hidden) { res.status(404).json({ ok: false, error: "No analytics for that pad." }); return null; }
    if (!ctx.open) { res.status(403).json({ ok: false, error: NOPE }); return null; }
    ctx.role = await seeThroughRole(req.user, ctx.padId);
    if (needRole && !ctx.role) { res.status(403).json({ ok: false, error: NOPE }); return null; }
    return ctx;
  }
  // one private row: {row: its frog name, reason?} -> {real: the login, or null when the site doesn't know it} - one log row
  app.post("/p/:slug/analytics/reveal", addUser, async (req, res) => {
    try {
      const ctx = await seeCtx(req, res);
      if (!ctx) return;
      const want = str(req.body && req.body.row, 40);
      const { regs, mics } = await boards(ctx.r, { userId: req.user.userId });
      const row = want ? [...regs.shown, ...mics.shown].find((p) => p.anon && p.alias === want) : null;
      if (!row) return res.status(409).json({ ok: false, error: "The frog names on this page have changed (they turn over every day at 10:00 UTC) - reload the page." });
      const real = (await realLogins([row])).get(row.key) || null;
      await ST.log({ userId: req.user.userId, role: ctx.role, scope: SEE_LINE, roomId: ctx.padId, logins: real ? [real] : [], reason: req.body && req.body.reason, ref: "row" });
      res.json({ ok: true, row: want, real });
    } catch (e) {
      console.error("[roomstats] reveal:", e.message);
      res.status(500).json({ ok: false, error: "Couldn't reveal it - try again." });
    }
  });
  // the toggle: {on: true, reason?} shows real names on this pad's analytics (for this viewer) until {on: false}
  app.post("/p/:slug/analytics/seethrough", addUser, async (req, res) => {
    try {
      const on = !!(req.body && (req.body.on === true || req.body.on === "1" || req.body.on === "on"));
      const ctx = await seeCtx(req, res, on);                       // turning it OFF never needs the right (or the origin check)
      if (!ctx) return;
      if (on) await ST.toggleOn({ userId: req.user.userId, role: ctx.role, scope: SEE_TOGGLE, roomId: ctx.padId, reason: req.body && req.body.reason });
      else await ST.toggleOff({ userId: req.user.userId, scope: SEE_TOGGLE, roomId: ctx.padId, why: "viewer" });
      res.json({ ok: true, on });
    } catch (e) {
      console.error("[roomstats] see-through:", e.message);
      res.status(500).json({ ok: false, error: "Couldn't change it - try again." });
    }
  });
}

module.exports = { register, clean, forRoom, bySlug, listing, all, preview, sentenceTrim, histWhen, maskedLogins,
                   boards, seeThroughRole, loginsForHashes, SEE_LINE, SEE_TOGGLE };
