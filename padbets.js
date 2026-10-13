// padbets.js — 1.99ur: a pad's own prediction markets, betting pools and polls for its page (views/partials/pad-bets-card.ejs,
// the About tab's "Markets, pools & polls" card). Everything is found by the pad column (padlinks.js); the lists' own pages
// take ?pad=<slug> for the full set, and their create forms default to this pad.
"use strict";
const { getQuery } = require("./dbUtils");

const SHOW = 4;

async function forPad(padId) {
  if (!padId) return null;
  const markets = require("./markets");
  const polls = require("./polls");
  const out = { markets: [], pools: [], polls: [], counts: { markets: 0, pools: 0, polls: 0 } };
  const now = Date.now() / 1000;
  let rows = [];
  try { rows = await getQuery("SELECT data FROM markets WHERE pad = ? ORDER BY id DESC LIMIT 200", [padId]); } catch (e) { rows = []; }
  for (const r of rows) {
    let v;
    try { v = markets.view(JSON.parse(r.data)); } catch (e) { continue; }
    if (markets.isVoided(v)) continue;
    const live = ["open", "closed", "settling"].includes(v.status) && !v.settle;
    const kind = v.model === "lmsr" ? "markets" : "pools";
    out.counts[kind]++;
    if (!live) continue;
    const lead = (v.options || []).slice().sort((a, b) => (kind === "markets" ? (b.price || 0) - (a.price || 0) : (b.share || 0) - (a.share || 0)))[0] || null;
    out[kind].push({ id: v.id, ref: v.ref, question: v.question, status: v.status, open: v.status === "open" && Number(v.closes) > now,
                     closes: Number(v.closes) || 0, total: Number(v.total) || 0,
                     lead: lead ? { name: lead.name, pct: kind === "markets" ? Math.round((lead.price || 0) * 100) : lead.share || 0 } : null });
  }
  for (const k of ["markets", "pools"]) out[k] = out[k].sort((a, b) => a.closes - b.closes).slice(0, SHOW);
  let prow = [];
  try { prow = await getQuery("SELECT data FROM polls WHERE pad = ? ORDER BY updated DESC LIMIT 50", [padId]); } catch (e) { prow = []; }
  for (const r of prow) {
    let p;
    try { p = polls.view(JSON.parse(r.data), []); } catch (e) { continue; }
    out.counts.polls++;
    if (p.status === "active" || out.polls.length < 1) out.polls.push({ id: p.id, question: p.question, active: p.status === "active", total: p.total });
  }
  out.polls = out.polls.sort((a, b) => b.active - a.active).slice(0, 2);
  out.any = out.counts.markets + out.counts.pools + out.counts.polls > 0;
  return out;
}

module.exports = { forPad };
