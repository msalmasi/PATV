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
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const { _render: R } = require("./userstats");

const MAX_ROOMS = 30, DAYS = 90;
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
const person = (p) => {
  if (!p || typeof p !== "object") return null;
  const login = str(p.login, 40).toLowerCase();
  if (!LOGIN_RE.test(login)) return null;
  return { login, display: str(String(p.display == null ? "" : p.display).replace(/<[^<>]{0,40}>/g, ""), 40).replace(/[<>]/g, "") || login, m30: int(p.m30), s30: int(p.s30), d30: int(p.d30, 0, 31),
           m90: int(p.m90), s90: int(p.s90), d90: int(p.d90, 0, 91), last: int(p.last) };
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
      summary: str(k.summary, 400), vibe: str(k.vibe, 160), at: int(k.at),
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

/** The analytics page's view model. */
async function forRoom(r, slug) {
  const md = await meta().catch(() => ({}));
  const today = new Date().toISOString().slice(0, 10);
  const latest = Object.keys(r.days || {}).sort().pop();
  const axis = R.dayAxis(latest && latest > today ? latest : today, DAYS);
  const d30 = axis[axis.length - 30], d90 = axis[0];
  const days = r.days || {};
  // people: privacy per linked PATV account
  const priv = await privateLogins([...r.regulars, ...r.mic_top].map((p) => p.login));
  const named = (list) => {
    const shown = [];
    let hidden = 0;
    for (const p of list) {
      const a = priv.get(p.login);
      if (a && a.private) { hidden++; continue; }
      shown.push({ ...p, href: a && a.username ? `/u/${encodeURIComponent(a.username)}` : null });
    }
    return { shown, hidden };
  };
  const regs = named(r.regulars);
  const mics = named(r.mic_top);
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
  const prev30 = axis[axis.length - 60];
  const msgs30 = sumDays(days, d30, (v) => v.m);
  const msgsPrev = Object.entries(days).filter(([k]) => k >= prev30 && k < d30).reduce((a, [, v]) => a + v.m, 0);
  const avgVisitors = Math.round(visitorDays30 / 30);
  const how = r.how || [], hows = r.hows || [];
  const k = r.knowledge || {};
  const wmax = Math.max(1, ...(k.topics || []).map((t) => t.w));
  return {
    name: r.name, slug, tz: md.tz || "", updated: r.updated ? R.ago(Math.floor(r.updated / 1000)) : null,
    tiles: {
      msgs30: R.fmt(msgs30), msgsTrend: msgsPrev > 50 ? Math.round(((msgs30 - msgsPrev) / msgsPrev) * 100) : null,
      mic30: R.dur(sumDays(days, d30, (v) => v.s)), cmds30: R.fmt(sumDays(days, d30, (v) => v.k)),
      avgVisitors: R.fmt(avgVisitors), new30: R.fmt(new30), new90: R.fmt(new90),
      uniq30: R.fmt((r.uniq || {}).d30 || 0), returning30: R.fmt(Math.max(0, ((r.uniq || {}).d30 || 0) - new30)),
      uniq90: R.fmt((r.uniq || {}).d90 || 0),
      typical: r.size && r.size.typical != null ? R.fmt(r.size.typical) : "—",
      typicalNote: r.size && r.size.src === "roster" ? "people in the room" : "people around per hour",
      peakSize: r.size && r.size.peak != null ? R.fmt(r.size.peak) : null,
      peak: r.peak || "—", first: R.dateOf(r.first), last: R.ago(r.last),
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
    regulars: regs.shown.map((p, i) => ({ rank: i + 1, name: p.display, href: p.href, d30: p.d30, m30: R.fmt(p.m30), mic30: p.s30 ? R.dur(p.s30) : "—",
                                           d90: p.d90, last: R.ago(p.last) })),
    regularsHidden: regs.hidden,
    mic: mics.shown.map((p, i) => ({ rank: i + 1, name: p.display, href: p.href, dur: R.dur(p.s90), days: p.d90, pct: Math.max(3, (p.s90 / micMax) * 100) })),
    micHidden: mics.hidden,
    cmds: top.map(([c, n, cat]) => ({ cmd: "!" + c, n: R.fmt(n), pct: Math.max(3, (n / cmax) * 100), color: (CAT[cat] || [0, "#90a4ae"])[1], cat: (CAT[cat] || [cat])[0] })),
    cats: cats.map(([c, n]) => ({ label: (CAT[c] || [c])[0], color: (CAT[c] || [0, "#90a4ae"])[1], n: R.fmt(n), pct: (n / catSum) * 100 })),
    games: gameRows, mod: modRows, modTotal: R.fmt(Object.values(mod90).reduce((a, b) => a + b, 0)),
    know: {
      has: !!(k.summary || (k.topics || []).length), summary: k.summary || "", vibe: k.vibe || "",
      at: k.at ? R.ago(k.at) : null,
      topics: (k.topics || []).map((t) => ({ t: t.t, w: t.w, size: (0.85 + 0.45 * (t.w / wmax)).toFixed(2) })),
      jokes: k.jokes || [], events: k.events || [], rules: k.rules || [],
    },
    changes: r.changes || [],
    history: (r.history || []).slice(-8).reverse().map((h) => ({ when: R.dateOf(h.at), topics: h.topics })),
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
    } catch (e) { res.locals.roomAnalytics = null; }
    next();
  });

  app.get("/p/:slug/analytics", addUser, async (req, res) => {
    const user = req.user ? req.user.username : null;
    const signedIn = !!(req.user && req.user.userId);
    let r = null;
    try { r = await bySlug(req.params.slug); } catch (e) { r = null; }
    if (!r) {
      return res.status(404).render("notFound", { user, heading: "No analytics for that pad",
        message: "Pepe hasn't sent analytics for that pad's Camfrog room (yet).", title: "Pad not found" });
    }
    const slug = String(req.params.slug).toLowerCase();
    res.set("Cache-Control", "private, no-store");
    let a = null;
    if (signedIn) {
      try { a = await forRoom(r, slug); } catch (e) { console.error("[roomstats] view:", e); a = null; }
    }
    let bridged = false;
    try { const b = bridgeMod(); bridged = !!(b && b._rooms && [...b._rooms.values()].some((x) => x.id === r.room)); } catch (e) { bridged = false; }
    res.render("room-analytics", { user, signedIn, room: { name: r.name, slug, bridged }, a });
  });
}

module.exports = { register, clean, forRoom, bySlug, listing, all };
