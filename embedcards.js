// embedcards.js — live link-preview cards on the feed (1.99xx). A feed post or comment that links to a prediction market,
// a betting pool, a poll or a bounty on this site shows a card for it (public/js/embed-cards.js finds the links) with its
// current prices / pool split / vote split, pot or volume, time left, status and pad. The feed has no SSE, so the client
// polls GET /api/embeds?refs=M12,P:poll_ab12,BT3 (batched, at most MAX_REFS refs) every ~25 s while the tab is visible.
//
// Refs: M<id> (markets AND pools - the same `markets` table; /markets/<id>), P:<poll id> (/polls/<id>), BT<id> (bounties),
// 1.99xk: R<id> (🎫 raffles, raffles.js cards(); /raffles/<id>).
// Privacy: an item on an Approved pad the viewer can't see (padaccess.canSee) comes back as null - exactly like a missing
// item, so the endpoint can't be used to probe what exists. No auth needed; the answer is viewer-aware, so it's cached
// privately and briefly.
"use strict";
const { getQuery } = require("./dbUtils");

const MAX_REFS = 30;
const CACHE_SECS = 10;

const str = (v) => String(v == null ? "" : v).trim();
const ms = (t) => { const n = Number(t) || 0; return n <= 0 ? null : n < 1e12 ? Math.round(n * 1000) : n; };   // unix s or ms -> ms

/** "M12", "m:12", "P:poll_ab", "BT3", "bt:3" -> {kind, id, ref} | null (ref is the canonical spelling). */
function parseRef(s) {
  const t = str(s);
  let m = t.match(/^m:?(\d{1,9})$/i);
  if (m) return { kind: "m", id: parseInt(m[1], 10), ref: "M" + parseInt(m[1], 10) };
  m = t.match(/^bt:?(\d{1,9})$/i);
  if (m) return { kind: "bt", id: parseInt(m[1], 10), ref: "BT" + parseInt(m[1], 10) };
  m = t.match(/^r:?(\d{1,9})$/i);
  if (m) return { kind: "r", id: parseInt(m[1], 10), ref: "R" + parseInt(m[1], 10) };
  m = t.match(/^p:([A-Za-z0-9_-]{1,40})$/i);
  if (m) return { kind: "p", id: m[1], ref: "P:" + m[1] };
  return null;
}

/** A refs query value -> unique parsed refs (at most MAX_REFS). */
function parseRefs(q) {
  const out = [], seen = new Set();
  for (const part of str(Array.isArray(q) ? q.join(",") : q).split(",")) {
    const r = parseRef(part);
    if (!r || seen.has(r.ref)) continue;
    seen.add(r.ref);
    out.push(r);
    if (out.length >= MAX_REFS) break;
  }
  return out;
}

function padOf(padId, rec) {
  const padlinks = require("./padlinks");
  const id = padId || padlinks.resolve(rec || {});
  return { id: id || null, view: id ? padlinks.view(id) : null };
}

function canSee(viewer, padId) {
  if (!padId) return true;
  try { return require("./padaccess").canSee(viewer, padId); } catch (e) { return false; }
}

/** A market / pool row -> its card. */
function marketCard(row, nowMs) {
  const markets = require("./markets");
  const raw = JSON.parse(row.data);
  const v = markets.view(raw);
  const closes = ms(v.closes);
  const st = str(v.status).toLowerCase();
  const isVoid = st === "void" || (v.settle && v.settle.kind === "void") || /^void\b/i.test(str(v.result));
  let status;
  if (isVoid) status = "void";
  else if ((v.settle && v.settle.kind === "won") || st === "settled" || st === "resolved") status = "settled";
  else if (st === "settling") status = "settling";
  else if (st === "open" && (!closes || closes > nowMs)) status = "open";
  else status = "closed";
  const result = status === "settled" ? str((v.settle && v.settle.result) || v.result) || null : null;
  const base = { ref: "M" + v.id, id: v.id, url: "/markets/" + v.id, title: str(v.question), status, closes, result };
  if (v.shares) {
    return { ...base, kind: "market",
      options: (v.options || []).map((o) => ({ name: o.name, price: Number.isFinite(o.price) ? o.price : 0, won: !!o.won && status === "settled" })),
      volume: Math.floor(Number(v.total) || 0), traders: v.bettors || 0 };
  }
  return { ...base, kind: "pool",
    options: (v.options || []).map((o) => ({ name: o.name, pool: o.pool, share: o.share, mult: o.mult == null ? null : Math.round(o.mult * 100) / 100,
                                             won: !!o.won && status === "settled" })),
    pot: Math.floor(Number(v.total) || 0), bettors: v.bettors || 0 };
}

function pollCard(row) {
  const raw = JSON.parse(row.data);
  const v = require("./polls").view({ ...raw, options: raw.options || [], votes: raw.votes || {} }, []);
  return { ref: "P:" + v.id, kind: "poll", id: v.id, url: "/polls/" + encodeURIComponent(v.id), title: str(v.question),
           status: v.status === "active" ? "open" : "ended", closes: null, result: null,
           options: v.rows.map((r) => ({ name: r.text, count: r.count, pct: r.pct, lead: r.lead })), votes: v.total };
}

function bountyCard(row, nowMs) {
  const raw = JSON.parse(row.data);
  const v = require("./bounties").view(raw, []);
  const deadline = ms(v.deadline);
  const st = str(v.status).toLowerCase();
  const status = st === "open" ? (!deadline || deadline > nowMs ? "open" : "closed")
    : st === "resolved" ? "settled" : st === "cancelled" ? "void" : st === "expired" ? "expired" : "closed";
  return { ref: "BT" + v.id, kind: "bounty", id: v.id, url: "/bounties/" + v.id, title: str(v.task), status, closes: deadline, result: null,
           pot: Math.floor(Number(v.total) || 0), backers: (v.backers || []).length, claims: (v.claims || []).length };
}

/**
 * The cards for these refs as `viewer` (req.user or null) may see them. -> {ref: card | null}
 * null = no such item, or it's on a pad the viewer can't see (the same answer on purpose).
 */
async function build(refs, viewer, nowMs = Date.now()) {
  const out = {};
  if (!refs.length) return out;
  try { await require("./padlinks").ready(); } catch (e) { /* the registry cache: pads show as site-wide */ }
  try { await require("./padaccess").init(); } catch (e) { /* canSee refuses below */ }
  const ids = (k) => refs.filter((r) => r.kind === k).map((r) => r.id);
  const q = async (sql, list) => (list.length ? getQuery(sql.replace("?", list.map(() => "?").join(",")), list).catch(() => []) : []);
  const mRows = await q("SELECT id, data, pad FROM markets WHERE id IN (?)", ids("m"));
  const pRows = await q("SELECT id, data, pad FROM polls WHERE id IN (?)", ids("p"));
  const bRows = await q("SELECT id, data FROM bounties WHERE id IN (?)", ids("bt"));
  for (const r of refs) out[r.ref] = null;
  const add = (ref, padId, rec, make) => {
    try {
      const pad = padOf(padId, rec);
      if (!canSee(viewer, pad.id)) return;
      out[ref] = { ...make(), pad: pad.view };
    } catch (e) { console.error("[embeds]", ref, e.message); }
  };
  for (const row of mRows) { let raw = {}; try { raw = JSON.parse(row.data); } catch (e) { continue; } add("M" + row.id, row.pad, raw, () => marketCard(row, nowMs)); }
  for (const row of pRows) { let raw = {}; try { raw = JSON.parse(row.data); } catch (e) { continue; } add("P:" + row.id, row.pad, raw, () => pollCard(row)); }
  for (const row of bRows) { let raw = {}; try { raw = JSON.parse(row.data); } catch (e) { continue; } add("BT" + row.id, null, { room: raw.room }, () => bountyCard(row, nowMs)); }
  // 1.99xk: raffles answer for themselves (their own pad check: an invisible pad's raffle stays null)
  const rIds = ids("r");
  if (rIds.length) {
    try { Object.assign(out, await require("./raffles").cards(rIds, viewer)); } catch (e) { console.error("[embeds] raffles:", e.message); }
  }
  return out;
}

function register(app, { addUser }) {
  app.get("/api/embeds", addUser, async (req, res) => {
    const refs = parseRefs(req.query.refs);
    res.set("Cache-Control", `private, max-age=${CACHE_SECS}`);
    res.set("Vary", "Cookie");
    try {
      const now = Date.now();
      res.json({ ok: true, now, items: await build(refs, req.user || null, now) });
    } catch (e) {
      console.error("[embeds] build:", e);
      res.status(500).json({ ok: false });
    }
  });
}

/**
 * 1.99ade: the item a link to one of this site's own pages is about (public/js/embed-cards.js shows its live card) -> "M12" |
 * "BT3" | "P:poll_ab" | "R7" | null. A preview of such a page frozen into a feed post (feedweb previewFor) is shown, indexed
 * and handed to Pepe only while the item is one a signed-out visitor may see (anonMissing): a frozen copy kept a market's
 * question and odds, or a bounty's task, for everyone after its pad went members-only.
 * 1.99ade: matched the way the site routes the address, so no spelling of it slips past: the host in any case, with a
 * trailing dot, any port or a user:password@ in front; the path in any case with one trailing slash; the id segment
 * percent-decoded and parsed as each page parses it (parseInt after its prefix: /markets/5abc and /markets/%35 are M5).
 */
function liveRef(href) {
  let u;
  try { u = new URL(String(href || "").trim()); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const hostOf = (h) => String(h || "").toLowerCase().replace(/:\d*$/, "").replace(/\.+$/, "");
  const ours = new Set([...require("./dmembeds").siteHosts()].map(hostOf));
  if (!ours.has(hostOf(u.hostname))) return null;
  const m = /^\/(markets|bounties|polls|raffles)\/([^/]+)\/?$/i.exec(u.pathname);
  if (!m) return null;
  let seg;
  try { seg = decodeURIComponent(m[2]); } catch (e) { return null; }
  const kind = m[1].toLowerCase();
  if (kind === "polls") return /^[A-Za-z0-9_-]{1,40}$/.test(seg) ? "P:" + seg : null;     // polls.js: an exact id
  // markets.js / bounties.js / raffles.js raffleRow: the prefix off, then parseInt
  const n = parseInt(seg.replace(kind === "markets" ? /^m/i : kind === "bounties" ? /^bt/i : /^#?r(?:f)?/i, ""), 10);
  if (!(n > 0) || n > 999999999) return null;
  return (kind === "markets" ? "M" : kind === "bounties" ? "BT" : "R") + n;
}

/**
 * 1.99ade: of these refs (liveRef's "M12" / "BT3" / "P:x" / "R7"), the ones a SIGNED-OUT visitor can't see - missing, or on
 * an Approved pad (build()'s rule, which answers both the same). -> Set of refs. Fails closed: an error = all of them.
 */
async function anonMissing(refs) {
  const list = [...new Set((refs || []).filter(Boolean).map(String))];
  if (!list.length) return new Set();
  try {
    const parsed = list.map(parseRef).filter(Boolean);
    const cards = await build(parsed, null);
    return new Set(list.filter((r) => { const p = parseRef(r); return !p || !cards[p.ref]; }));
  } catch (e) {
    console.error("[embeds] anonMissing:", e.message);
    return new Set(list);
  }
}

module.exports = { register, build, parseRef, parseRefs, liveRef, anonMissing, MAX_REFS };
