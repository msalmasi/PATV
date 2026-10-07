// userstats.js — per-user Camfrog activity analytics on profiles (1.99).
//
// Pepe keeps the aggregates (pepe_userstats.py in the bot: chat per day / hour / room, mic time,
// moderation done and received, keyed by the real lowercased Camfrog login) and pushes the users
// that changed to POST /api/userstats/sync (bot token). We keep the latest copy per login and render
// it on /u/:username for the account whose camfrogUsername matches.
//
// Privacy (1.99h): each user picks it on their profile layout (profilelayout.js), default Public.
//   * chat + mic aggregates, mod-action counts, commands: Public or Hidden
//   * top words (an_words), moderation RECEIVED / "moderated against" (an_modon), the itemised list of
//     mod actions taken (an_modlist), moderation/admin commands (an_modcmds): Public, Only me & admins,
//     or Hidden. forProfile() only includes a panel's data when the viewer may see it.
//   * top words never exist for !incognito users: the bot doesn't store them (pepe_userstats.py)
//
// The sync also carries heist-sheet avatar seeds ({login: seed}) into cosmetic_avatar_seeds (the
// table cosmetics.js reads), so every player with a sheet gets their GTF avatar on the profile —
// before, a seed only arrived when the sheet happened to be re-published. avatarFor() renders that
// avatar server-side with public/js/avatar.js (a pure function), so it can't fail to load.
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");

const ready = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS camfrog_userstats (
    login TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS camfrog_userstats_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1), tz TEXT, days INTEGER, updated INTEGER)`);
  // same schema as cosmetics.js creates (whichever module boots first makes it)
  await runQuery("CREATE TABLE IF NOT EXISTS cosmetic_avatar_seeds (camfrog TEXT PRIMARY KEY, seed INTEGER, updated INTEGER)");
})().catch((e) => console.error("[userstats] init:", e));

const MAX_USERS = 200, DAYS = 90, RECENT = 20;
const int = (v, lo = 0, hi = Number.MAX_SAFE_INTEGER) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0; };
const str = (v, n = 64) => String(v == null ? "" : v).slice(0, n);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-z_]{2,24}$/;

function map(o, n, valFn, keyFn = (k) => str(k)) {
  const out = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o).slice(0, n)) {
    const kk = keyFn(k);
    if (kk) out[kk] = valFn(v);
  }
  return out;
}
const hours = (a) => Array.from({ length: 24 }, (_, i) => num(Array.isArray(a) ? a[i] : 0));
const days = (o) => map(o, DAYS + 10, num, (k) => (DAY_RE.test(k) ? k : null));
const counts = (o) => map(o, 30, (v) => int(v), (k) => (KEY_RE.test(k) ? k : null));
const recent = (a) => (Array.isArray(a) ? a : []).slice(0, RECENT).filter((e) => e && typeof e === "object")
  .map((e) => ({ ts: int(e.ts), type: KEY_RE.test(String(e.type)) ? String(e.type) : "other",
                 room: str(e.room, 64), who: e.who ? str(e.who, 40) : null, note: e.note ? str(e.note, 40) : null }));

function clean(u) {
  const login = str(u.login, 40).toLowerCase();
  if (!/^[\w.\-]{2,40}$/.test(login)) return null;
  const out = { login, first: int(u.first), last: int(u.last) };
  if (u.chat && typeof u.chat === "object") {
    const c = u.chat;
    out.chat = { total: int(c.total), cmds: int(c.cmds), avg_len: num(c.avg_len), first: int(c.first), last: int(c.last),
                 days: days(c.days), hours: hours(c.hours), rooms: map(c.rooms, 8, (v) => int(v)),
                 words: map(c.words, 30, (v) => int(v), (k) => (/^[a-z']{3,16}$/.test(k) ? k : null)) };
  }
  if (u.mic && typeof u.mic === "object") {
    const m = u.mic;
    out.mic = { secs: int(m.secs), sessions: int(m.sessions), longest: int(m.longest), last: int(m.last),
                days: days(m.days), hours: hours(m.hours), rooms: map(m.rooms, 8, (v) => int(v)) };
  }
  if (u.cmds && typeof u.cmds === "object") {
    const k = u.cmds;
    const top = (a) => (Array.isArray(a) ? a : []).slice(0, 15).filter((t) => Array.isArray(t) && /^[a-z0-9_]{1,24}$/.test(String(t[0])))
      .map((t) => [String(t[0]), int(t[1]), int(t[2]), KEY_RE.test(String(t[3])) ? String(t[3]) : "utility"]);
    out.cmds = { total: int(k.total), mod_total: int(k.mod_total), paid: int(k.paid), days: days(k.days), mod_days: days(k.mod_days),
                 cats: counts(k.cats), sources: counts(k.sources), top: top(k.top), mod_top: top(k.mod_top) };
  }
  if (u.mod && typeof u.mod === "object") {
    out.mod = { by: counts(u.mod.by), on: counts(u.mod.on), by_recent: recent(u.mod.by_recent), on_recent: recent(u.mod.on_recent) };
  }
  return out;
}

async function get(login) {
  if (!login) return null;
  await ready;
  const rows = await getQuery("SELECT data, updated FROM camfrog_userstats WHERE login = ?", [String(login).toLowerCase()]);
  if (!rows.length) return null;
  try { return Object.assign(JSON.parse(rows[0].data), { updated: rows[0].updated }); } catch (e) { return null; }
}

async function meta() {
  await ready;
  const rows = await getQuery("SELECT tz, days, updated FROM camfrog_userstats_meta WHERE id = 1");
  return rows[0] || {};
}

// ── rendering helpers (server-side SVG; no client libraries) ──
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (k) => { const [, m, d] = k.split("-"); return `${MON[+m - 1]} ${+d}`; };
function dur(secs) {
  secs = Math.round(secs || 0);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
function ago(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 60) { const d = Math.round(s / 86400); return `${d} day${d === 1 ? "" : "s"} ago`; }
  return dateOf(ts);
}
function dateOf(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function niceMax(v) {
  if (v <= 4) return Math.max(1, Math.ceil(v));
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** The last `n` day keys ending at `end` (YYYY-MM-DD), oldest first. */
function dayAxis(end, n) {
  const [y, m, d] = end.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}

/** 90-day bar chart. values: {day: n}; fmtV(n) -> tooltip value text. */
// The bars are an SVG stretched to the box (preserveAspectRatio=none, so it fills any width without
// shrinking anything); the axis labels are HTML positioned in % so text stays readable on a phone.
function barChart(axis, values, { color, fmtV, unit, label }) {
  const W = axis.length * 8, H = 100;
  const vals = axis.map((k) => Number(values[k] || 0));
  const max = niceMax(Math.max(...vals, 0) || 1);
  const bw = 6;
  let bars = "", hits = "", xl = "";
  axis.forEach((k, i) => {
    const v = vals[i];
    const x = i * 8 + 1;
    const tip = `${dayLabel(k)} · ${fmtV(v)}`;
    if (v > 0) {
      const h = Math.max(1.5, (v / max) * H);
      bars += `<rect x="${x}" y="${(H - h).toFixed(2)}" width="${bw}" height="${h.toFixed(2)}" rx="1.5" fill="${color}"/>`;
    }
    // full-height hit target so empty days and thin bars are hoverable too
    hits += `<rect x="${i * 8}" y="0" width="8" height="${H}" class="ua-hit" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
    if ((i % 15 === 0 && axis.length - 1 - i >= 14) || i === axis.length - 1) {
      const left = ((i * 8 + 4) / W) * 100;
      xl += `<span style="left:${left.toFixed(2)}%"${i === axis.length - 1 ? ' class="end"' : ""}>${esc(dayLabel(k))}</span>`;
    }
  });
  const yl = [1, 0.5].map((f) => `<span style="top:${((1 - f) * 100).toFixed(0)}%">${esc(unit(max * f))}</span>`).join("");
  const grid = [0, 0.5].map((f) => `<line x1="0" x2="${W}" y1="${f * H}" y2="${f * H}" class="ua-grid"/>`).join("")
    + `<line x1="0" x2="${W}" y1="${H}" y2="${H}" class="ua-base"/>`;
  const total = vals.reduce((a, b) => a + b, 0);
  return `<div class="ua-bars"><div class="ua-yl" aria-hidden="true">${yl}</div>`
    + `<svg class="ua-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: ${esc(fmtV(total))} over the last ${axis.length} days">${grid}${bars}${hits}</svg>`
    + `<div class="ua-xl" aria-hidden="true">${xl}</div></div>`;
}

/** One 24-cell hour strip (a sequential heatmap row), as HTML cells. */
function hourRow(name, arr, rgb, fmtV) {
  const max = Math.max(...arr, 0);
  let cells = "";
  for (let h = 0; h < 24; h++) {
    const v = arr[h] || 0;
    const a = max ? 0.1 + 0.9 * Math.pow(v / max, 0.75) : 0;
    const tip = `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00 · ${fmtV(v)}`;
    cells += `<span class="ua-cell" style="background:${v ? `rgba(${rgb},${a.toFixed(2)})` : "#191919"}" data-tip="${esc(tip)}" title="${esc(tip)}"></span>`;
  }
  return `<div class="ua-hrow"><span class="ua-hname">${esc(name)}</span><div class="ua-cells">${cells}</div></div>`;
}

const TYPE_LABEL = {
  kick: ["Kicks", "Kicked"], ban: ["Bans", "Banned"], mute: ["Mutes", "Muted"], mic_block: ["Mic blocks", "Mic blocked"],
  demote: ["Demotions", "Demoted"], fine: ["Fines", "Fined"], warning: ["Warnings", "Warned"],
  mic_unblock: ["Mic unblocks", "Mic unblocked"], unmute: ["Unmutes", "Unmuted"], unban: ["Unbans", "Unbanned"],
  promote: ["Promotions", "Promoted"], strike: ["Automod strikes", "Automod strike"],
  michog_strike: ["Mic-hog strikes", "Mic-hog strike"], timeout: ["Time-outs", "Timed out"],
  demoted: ["Automod demotions", "Demoted by automod"], suspension: ["Red-list suspensions", "Red-list suspended"],
  topic: ["Topic changes", "Topic changed"],   // 2.00: actor-only (count + time + room; never the topic text)
};
const SINGULAR = { kick: "Kick", ban: "Ban", mute: "Mute", mic_block: "Mic block", demote: "Demotion", fine: "Fine",
  warning: "Warning", mic_unblock: "Mic unblock", unmute: "Unmute", unban: "Unban", promote: "Promotion",
  topic: "Topic change" };
// i: 0 = plural count label, 1 = "done to them" label, 2 = one action they took
const typeName = (t, i = 0) => (i === 2 ? SINGULAR[t] || t : (TYPE_LABEL[t] || [t, t])[i]);

// "camfrog" is Pepe's bucket for history logged before he tracked rooms (and for anything he
// couldn't place) — say so instead of showing it like a room called "camfrog".
const GENERAL = "camfrog";
const roomName = (r) => (r === GENERAL ? "Before rooms were tracked" : r);

function roomBars(rooms, fmtV) {
  const list = Object.entries(rooms || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = list.length ? list[0][1] : 0;
  return list.map(([r, v]) => ({ room: roomName(r), value: v, label: fmtV(v), pct: max ? Math.max(2, (v / max) * 100) : 0 }));
}

const CAT = {
  games: ["Games & casino", "#4caf50"], heists: ["Heists & GTF", "#ef5350"], economy: ["Economy", "#ffd54f"],
  music: ["Music", "#4fc3f7"], media: ["Cams & media", "#ba68c8"], ai: ["AI & chat", "#81c784"],
  utility: ["Utility", "#90a4ae"], moderation: ["Moderation & admin", "#ff8a65"],
};

/** Tiny 90-day sparkline (SVG, stretched; tooltips via data-tip like the bar charts). */
function sparkline(axis, values, color) {
  const W = axis.length * 4, H = 30;
  const vals = axis.map((k) => Number(values[k] || 0));
  const max = Math.max(...vals, 1);
  let out = "";
  axis.forEach((k, i) => {
    const v = vals[i];
    const tip = `${dayLabel(k)} · ${fmt(v)} command${v === 1 ? "" : "s"}`;
    if (v > 0) {
      const h = Math.max(1.5, (v / max) * H);
      out += `<rect x="${i * 4 + 0.5}" y="${(H - h).toFixed(2)}" width="3" height="${h.toFixed(2)}" fill="${color}"/>`;
    }
    out += `<rect x="${i * 4}" y="0" width="4" height="${H}" class="ua-hit" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
  });
  return `<svg class="ua-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Commands per day, last ${axis.length} days">`
    + `<line x1="0" x2="${W}" y1="${H}" y2="${H}" class="ua-base"/>${out}</svg>`;
}

function commandsModel(k, axis, priv) {
  if (!k || !(k.total > 0)) return null;
  const pubTotal = Math.max(0, k.total - (k.mod_total || 0));
  const total = priv ? k.total : pubTotal;
  if (!total) return null;
  const daysAll = Object.assign({}, k.days || {});
  if (priv) for (const [d, v] of Object.entries(k.mod_days || {})) daysAll[d] = (daysAll[d] || 0) + v;
  const cats = Object.entries(k.cats || {}).filter(([c, n]) => n > 0 && (priv || c !== "moderation"))
    .sort((a, b) => b[1] - a[1]);
  const catSum = cats.reduce((a, [, n]) => a + n, 0) || 1;
  const list = (priv ? [...(k.top || []), ...(k.mod_top || [])] : (k.top || []))
    .filter((t) => priv || t[3] !== "moderation").sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = list.length ? list[0][1] : 1;
  const d30 = axis[axis.length - 30];
  return {
    total: fmt(total), last30: fmt(Object.entries(daysAll).filter(([d]) => d >= d30).reduce((a, [, v]) => a + v, 0)),
    paid: fmt(k.paid || 0), paidPct: total ? Math.round(((k.paid || 0) / total) * 100) : 0,
    web: fmt((k.sources || {}).web || 0), pm: fmt((k.sources || {}).pm || 0),
    spark: sparkline(axis, daysAll, "#90caf9"),
    cats: cats.map(([c, n]) => ({ key: c, label: (CAT[c] || [c])[0], color: (CAT[c] || [0, "#90a4ae"])[1], n: fmt(n),
                                  pct: (n / catSum) * 100, priv: c === "moderation" })),
    top: list.map(([c, n, last, cat]) => ({ cmd: "!" + c, n: fmt(n), pct: Math.max(3, (n / max) * 100), last: ago(last),
                                           color: (CAT[cat] || [0, "#90a4ae"])[1], cat: (CAT[cat] || [cat])[0],
                                           priv: cat === "moderation" })),
    hasMod: priv && (k.mod_total || 0) > 0,
  };
}

/**
 * The view model for the profile's Analytics section, or null when there's nothing to show.
 * viewer: { owner: bool, admin: bool, show?: (panelId) => bool }
 *   show is profilelayout view().show - whether this viewer may see a panel. Without it (old callers)
 *   the privacy panels fall back to owner + admins only.
 */
async function forProfile(camfrogLogin, viewer) {
  if (!camfrogLogin) return null;
  let s;
  try { s = await get(camfrogLogin); } catch (e) { console.error("[userstats] get:", e); return null; }
  if (!s) return { empty: true };
  const md = await meta().catch(() => ({}));
  const v = viewer || {};
  const priv = !!(v.owner || v.admin);
  const may = typeof v.show === "function" ? (id) => !!v.show(id) : () => priv;
  const see = { words: may("an_words"), modOn: may("an_modon"), modList: may("an_mod") && may("an_modlist"),
                modCmds: may("an_cmds") && may("an_modcmds") };
  const c = s.chat || { total: 0, days: {}, hours: Array(24).fill(0), rooms: {} };
  const m = s.mic || { secs: 0, sessions: 0, longest: 0, days: {}, hours: Array(24).fill(0), rooms: {} };
  const today = new Date().toISOString().slice(0, 10);
  const latest = [...Object.keys(c.days || {}), ...Object.keys(m.days || {})].sort().pop();
  const axis = dayAxis(latest && latest > today ? latest : today, DAYS);
  const sumDays = (o, k0) => Object.entries(o || {}).filter(([k]) => k >= k0).reduce((a, [, v]) => a + v, 0);
  const d30 = axis[axis.length - 30];
  // favourite room: messages + one per mic minute
  const fav = {};
  for (const [r, v] of Object.entries(c.rooms || {})) fav[r] = (fav[r] || 0) + v;
  for (const [r, v] of Object.entries(m.rooms || {})) fav[r] = (fav[r] || 0) + v / 60;
  const favRoom = Object.entries(fav).filter(([r]) => r !== GENERAL).sort((a, b) => b[1] - a[1])[0];
  const peakChat = c.total ? c.hours.indexOf(Math.max(...c.hours)) : null;
  const peakMic = m.secs ? m.hours.indexOf(Math.max(...m.hours)) : null;
  const mod = s.mod || { by: {}, on: {}, by_recent: [], on_recent: [] };
  const byTotal = Object.values(mod.by || {}).reduce((a, b) => a + b, 0);
  const onTotal = Object.values(mod.on || {}).reduce((a, b) => a + b, 0);
  const sorted = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ type: t, label: typeName(t), n }));
  const rows = (list, side) => (list || []).map((e) => ({
    when: dateOf(e.ts), ago: ago(e.ts), label: typeName(e.type, side === "on" ? 1 : 2), room: e.room === GENERAL ? "—" : e.room,
    who: e.who, note: e.note }));
  return {
    empty: false,
    tz: md.tz || "",
    updated: s.updated ? ago(Math.floor(s.updated / 1000)) : null,
    tiles: {
      messages: fmt(c.total), messages30: fmt(sumDays(c.days, d30)), avgLen: c.avg_len || 0, cmds: fmt(c.cmds || 0),
      micHours: (m.secs / 3600).toFixed(m.secs >= 36000 ? 0 : 1), micDur: dur(m.secs), sessions: fmt(m.sessions),
      longest: dur(m.longest), avgSession: m.sessions ? dur(m.secs / m.sessions) : "—",
      first: dateOf(s.first), last: ago(s.last), favRoom: favRoom ? favRoom[0] : "—",
      peakChat: peakChat == null ? null : `${String(peakChat).padStart(2, "0")}:00`,
      peakMic: peakMic == null ? null : `${String(peakMic).padStart(2, "0")}:00`,
    },
    chatChart: barChart(axis, c.days || {}, { color: "#4caf50", label: "Messages per day",
      fmtV: (v) => `${fmt(v)} message${v === 1 ? "" : "s"}`, unit: (v) => fmt(v) }),
    micChart: barChart(axis, Object.fromEntries(Object.entries(m.days || {}).map(([k, v]) => [k, v / 60])),
      { color: "#ffb74d", label: "Mic minutes per day", fmtV: (v) => dur(v * 60), unit: (v) => `${fmt(v)}m` }),
    hasChat: !!c.total, hasMic: !!m.secs,
    cmds: commandsModel(s.cmds, axis, see.modCmds),
    chat30: sumDays(c.days, d30), mic30: sumDays(m.days, d30),
    hoursHtml: hourRow("Chat", c.hours, "76,175,80", (v) => `${fmt(v)} msgs`) + hourRow("Mic", m.hours, "255,183,77", (v) => dur(v)),
    chatRooms: roomBars(c.rooms, (v) => `${fmt(v)} msgs`),
    micRooms: roomBars(m.rooms, (v) => dur(v)),
    // incognito users have no words at all (empty list = the panel isn't rendered)
    words: see.words ? Object.entries(c.words || {}).sort((a, b) => b[1] - a[1]).slice(0, 20) : [],
    mod: {
      byTotal, byCounts: sorted(mod.by),
      byRecent: see.modList ? rows(mod.by_recent, "by") : [],
      // moderated against (null = not for this viewer: render nothing at all)
      on: see.modOn ? { total: onTotal, counts: sorted(mod.on), recent: rows(mod.on_recent, "on") } : null,
    },
    priv,
  };
}

// ── GTF avatar showcase (server-rendered; avatar.js is consumed as-is) ──
let _avatarFn = null;
function avatarFn() {
  if (!_avatarFn) {
    try {
      require("./public/js/avatar.js");                    // attaches pepeAvatarSVG to globalThis
      _avatarFn = typeof globalThis.pepeAvatarSVG === "function" ? globalThis.pepeAvatarSVG : null;
    } catch (e) {
      console.error("[userstats] avatar.js:", e.message);
    }
  }
  return _avatarFn;
}
const GTF_SLOT = { gtf_bg: "Background", gtf_outfit: "Outfit", gtf_mask: "Mask", gtf_hat: "Hat", gtf_prop: "Prop", gtf_frame: "Frame" };
const RARITY = { common: "#9e9e9e", uncommon: "#81c784", rare: "#4fc3f7", epic: "#ba68c8", legendary: "#ffb300" };

/** pc = res.locals.profileCosmetics ({seed, gtf, equipped}). -> {svg, items[]} or {svg:null} */
function avatarFor(pc) {
  const eq = (pc && pc.equipped) || {};
  const items = Object.keys(GTF_SLOT).filter((k) => eq[k] && eq[k].item).map((k) => ({
    slot: GTF_SLOT[k], name: eq[k].item.name, rarity: eq[k].item.rarity || "common",
    color: RARITY[eq[k].item.rarity] || RARITY.common, emoji: (eq[k].r && eq[k].r.emoji) || "", desc: eq[k].item.desc || "",
  }));
  let svg = null;
  const fn = avatarFn();
  if (fn && pc && pc.seed) {
    try { svg = fn(Number(pc.seed), 176, pc.gtf || {}); } catch (e) { console.error("[userstats] avatar render:", e.message); }
  }
  return { svg, items };
}

function register(app, { isBotToken }) {
  // A batch of 40 users with 90 days each can pass express.json()'s default 100kb — index.js lets
  // this path through to the larger parser here.
  app.post("/api/userstats/sync", express.json({ limit: "4mb" }), async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    try {
      await ready;
      const users = (Array.isArray(body.users) ? body.users : []).slice(0, MAX_USERS);
      const now = Date.now();
      let saved = 0, seeds = 0;
      const sd = body.seeds && typeof body.seeds === "object" && !Array.isArray(body.seeds) ? body.seeds : {};
      for (const [login, seed] of Object.entries(sd).slice(0, 1000)) {
        const l = str(login, 40).toLowerCase(), n = int(seed, 0, 2 ** 31);
        if (!/^[\w.\-]{2,40}$/.test(l) || !n) continue;
        await runQuery(`INSERT INTO cosmetic_avatar_seeds (camfrog, seed, updated) VALUES (?, ?, ?)
                        ON CONFLICT(camfrog) DO UPDATE SET seed = excluded.seed, updated = excluded.updated`, [l, n, now]);
        seeds++;
      }
      for (const u of users) {
        const row = u && typeof u === "object" ? clean(u) : null;
        if (!row) continue;
        await runQuery(`INSERT INTO camfrog_userstats (login, data, updated) VALUES (?, ?, ?)
                        ON CONFLICT(login) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
          [row.login, JSON.stringify(row), now]);
        saved++;
      }
      await runQuery(`INSERT INTO camfrog_userstats_meta (id, tz, days, updated) VALUES (1, ?, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET tz = excluded.tz, days = excluded.days, updated = excluded.updated`,
        [str(body.tz, 60), int(body.days, 1, 365) || DAYS, now]);
      res.json({ success: true, saved, seeds });
    } catch (e) {
      console.error("[userstats] sync:", e);
      res.status(500).json({ success: false, error: "sync failed" });
    }
  });
}

module.exports = { register, forProfile, get, clean, avatarFor,
  // shared chart/format helpers (roomstats.js renders room analytics with the same look)
  _render: { esc, fmt, dur, ago, dateOf, niceMax, dayLabel, dayAxis, barChart } };
