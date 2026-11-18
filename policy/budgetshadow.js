// policy/budgetshadow.js — the read-only check of the incentive week while Pepe still owns it (1.99aop).
//
// Pepe's side: the `incentives` block of his funding sync (his live `spent`, `budgets`, `remaining`), kept IN MEMORY only (a ring of
// the last samples, funding.sync -> noteSync: no database write on the sync path), plus his pushed econ_treasury doc (settled claim
// ids with his mark time, unsure ids, closed weeks).
// The site's side: its own ledger - pool_move_legs on the incentive pool, each leg classified to a budget group (classifyLeg).
//
//   drift[g] = Pepe's spent + effects he hasn't applied yet - the site's sum of the group's legs, from the week's start to the sample
//
// A correct system differs only for a moment (a debit landing, a claim being marked, an answer lost and reversed), so a difference is
// simply tried again on a later sample; only one that lasts the whole day fails it. Everything here reads; the results are its own
// policy_sims rows (mode shadow, engine budget), final once ok is set:
//   shadow:budget:D<date>   one per policy day: ok 1 = one attempt with every group's drift 0, every budget and capped remaining equal,
//                           no leg nobody can name; a clean read proves the week so far (the counters are cumulative)
//   shadow:budget:W<date>   the closed week: Pepe's weeks[] entry against the legs of [start, end)
// A count and its debit can land either side of the Monday boundary. That is excused only per group, when last week's and this
// week's drift cancel exactly AND named legs at the boundary add up to it - the row then records it as a carry, never silently.
"use strict";
const { runQuery, getQuery, tx } = require("../dbUtils");
const C = require("./core");
const E = require("./engines");

const B = () => require("./budget");

const RING_MAX = 32;                   // about 16 minutes of 30 s syncs
const QUIET_BEFORE_S = 60;             // no incentive leg this long before a sample ...
const QUIET_AFTER_S = 15;              // ... or this long after it (the sample's own in-flight debit and the sync that follows it)
const SAMPLE_MAX_AGE_S = 900;          // any sample since the previous attempt is usable
const ATTEMPT_EVERY_S = 900;
const MAX_ATTEMPTS = 60;
const START_S = 3600;                  // from 05:00 UTC: clear of the 04:00 runs and the 04:30 derived read
const END_S = 84600;                   // until 03:30 UTC next day
const UNSURE_GRACE_MS = 15 * 60000;    // above Pepe's UNCERTAIN_SETTLE_S: an "unsure" claim older than this is counted, so it shows
const BAND_S = 30;                     // a leg this close after the boundary may belong to the count before it
const IGNORED_KINDS = new Set(["cutover", "rollback", "refused", "import"]);
const NON_GROUP = new Set(["floor top-up", "vault lotto reseed"]);
const NAMED_WHY = { "activity top-up pool": "activity", "launchpad grant": "launchpad", "launchpad match": "launchpad" };
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const int = (v) => E.pyInt(v);

let clock = () => Date.now();
const ring = [];
let lastAttemptAt = 0;
const doneDays = new Set();

/** funding.sync: remember Pepe's block (memory only). Never throws. */
function noteSync(raw) {
  try {
    if (!raw || typeof raw !== "object" || !raw.spent || typeof raw.spent !== "object") return;
    const nums = (o) => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).map(([k, v]) => [String(k).slice(0, 32), int(v)]));
    ring.push({ at: clock() / 1000, week: String(raw.week || "").slice(0, 16), spent: nums(raw.spent), budgets: nums(raw.budgets), remaining: nums(raw.remaining),
                uncapped: Array.isArray(raw.uncapped) ? raw.uncapped.map(String).slice(0, 16) : [], balance: int(raw.balance),
                share: raw.share === undefined ? null : raw.share, release_per_day: raw.release_per_day === undefined ? null : raw.release_per_day });
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  } catch (e) { /* the sync path never fails for this */ }
}

// ── classifying a leg of the incentive pool ──
function flowGroup(name) {
  if (hasOwn(B().BOT_FLOWS, name)) return B().BOT_FLOWS[name];
  if (hasOwn(B().ACTIVITY_FLOWS, name)) return B().ACTIVITY_FLOWS[name];
  if (hasOwn(NAMED_WHY, name)) return NAMED_WHY[name];
  if (NON_GROUP.has(name) || / refunds$/.test(name)) return null;
  return undefined;
}
/**
 * One leg {move_key, amount, ts (ms), kind, flow, why} ->
 *   {c: "none"} | {c: "spend" | "back", group, amount (> 0), claimId?, orig?} | {c: "unmapped"} | {c: "inflight", claimId}
 * ctx: {unsure: {claimId: since}, nowMs}. `why` first: `flow` can carry a shared tag, `why` is what the caller passed.
 */
function classifyLeg(l, ctx = {}) {
  const key = String(l.move_key || ""), why = String(l.why || ""), amount = int(l.amount);
  if (IGNORED_KINDS.has(String(l.kind || ""))) return { c: "none" };
  if (key.endsWith(":undo")) {
    const base = key.slice(0, -5);
    const m = /^undo (.+?) \(/.exec(why);
    if (!m) return { c: "unmapped" };
    const g = base.startsWith("claim:") ? B().groupOfClaim(m[1]) : flowGroup(m[1]);
    if (g === undefined) return { c: "unmapped" };
    return g === null ? { c: "none" } : { c: "back", group: g, amount: Math.abs(amount), orig: base };
  }
  if (key.startsWith("claim:")) {
    const claimId = key.slice(6);
    const unsure = ctx.unsure || {};
    let stuck = false;
    if (hasOwn(unsure, claimId) && amount < 0) {
      if ((Number(ctx.nowMs) || 0) - Number(l.ts) < UNSURE_GRACE_MS) return { c: "inflight", claimId };
      stuck = true;
    }
    const g = B().groupOfClaim(why === "website grant" ? "" : why);
    if (g === null) return { c: "none" };
    return Object.assign({ c: amount < 0 ? "spend" : "back", group: g, amount: Math.abs(amount), claimId }, stuck ? { stuck: true } : {});
  }
  if (amount > 0) {
    if (!/ returned$/.test(why)) return { c: "none" };                 // an inflow
    const g = flowGroup(why.slice(0, -" returned".length));
    if (g === undefined) return { c: "unmapped" };
    return g === null ? { c: "none" } : { c: "back", group: g, amount };
  }
  let g = flowGroup(why);
  if (g === undefined && String(l.flow || "") === "turf_tick") g = "turf";
  if (g === undefined) return { c: "unmapped" };
  return g === null ? { c: "none" } : { c: "spend", group: g, amount: -amount };
}

/** The site's spent per group for [fromMs, toMs), only what had happened before cutMs (null: everything). Replays in order with
 *  Pepe's floor: a give-back never takes a group below 0. */
function siteWeek(legs, { fromMs, toMs, cutMs = null, doc = {}, nowMs }) {
  const settled = doc.settled && typeof doc.settled === "object" ? doc.settled : {};
  const unsure = doc.unsure && typeof doc.unsure === "object" ? doc.unsure : {};
  const byKey = new Map(legs.map((l) => [String(l.move_key), Number(l.ts)]));
  const events = [], unmapped = [], stuck = [];
  let inflight = 0;
  for (const l of legs) {
    const ev = classifyLeg(l, { unsure, nowMs });
    if (ev.c === "none") continue;
    let at = Number(l.ts), seen = Number(l.ts);
    if (ev.claimId && hasOwn(settled, ev.claimId)) { at = Number(settled[ev.claimId]) * 1000; seen = at; }
    if (ev.orig && byKey.has(ev.orig)) at = byKey.get(ev.orig);
    if (!(at >= fromMs && at < toMs) || (cutMs !== null && seen >= cutMs)) continue;
    if (ev.c === "inflight") { inflight++; continue; }
    if (ev.c === "unmapped") { unmapped.push({ key: String(l.move_key).slice(0, 80), why: String(l.why || "").slice(0, 60), flow: String(l.flow || "").slice(0, 40), amount: int(l.amount) }); continue; }
    if (ev.stuck) stuck.push(ev.claimId);
    events.push({ key: String(l.move_key), group: ev.group, delta: ev.c === "spend" ? ev.amount : -ev.amount, back: ev.c === "back", at });
  }
  events.sort((a, b) => a.at - b.at);
  const spent = Object.fromEntries(E.GROUPS.map((g) => [g, 0]));
  for (const e of events) spent[e.group] = e.back ? Math.max(0, (spent[e.group] || 0) + e.delta) : (spent[e.group] || 0) + e.delta;
  return { spent, events, unmapped, stuck, inflight };
}
/** A subset of `items` ({key, delta}) that sums to `target` (bounded: the boundary holds a handful of legs), or null. */
function subsetSum(items, target) {
  const list = items.slice(0, 20);
  const walk = (i, left, got) => {
    if (left === 0 && got.length) return got;
    if (i >= list.length) return null;
    return walk(i + 1, left - list[i].delta, got.concat(list[i].key)) || walk(i + 1, left, got);
  };
  return walk(0, target, []);
}
/** The legs of the week that may belong to a count made before its boundary: right after it, or a journaled top-up / launchpad leg
 *  that lands later (those are counted when journaled, so an outage can carry them across). */
function boundaryCandidates(events, startMs) {
  const startDay = new Date(startMs).toISOString().slice(0, 10);
  const out = {};
  for (const e of events) {
    const m = /^rctopa-(\d{4}-\d{2}-\d{2})-/.exec(e.key);
    const named = (m && m[1] < startDay) || /^lp-grant-|^lpm-/.test(e.key);
    if (named || e.at < startMs + BAND_S * 1000) (out[e.group] = out[e.group] || []).push(e);
  }
  return out;
}
/** Per group: this week's drift cancels last week's exactly and named legs add up to it -> {group: {amount, legs}}. */
function explainCarry(drift, prevDrift, candidates) {
  const carry = {};
  for (const g of E.GROUPS) {
    const d = int(drift[g]);
    if (!d || !prevDrift || int(prevDrift[g]) !== -d) continue;
    const keys = subsetSum(candidates[g] || [], -d);
    if (keys) carry[g] = { amount: d, legs: keys.slice(0, 12) };
  }
  return carry;
}
const driftOf = (pepe, site, pending = {}) => Object.fromEntries(E.GROUPS.map((g) => [g, int(pepe[g]) + int(pending[g]) - int(site[g])]));
const nonZero = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
const weekDoc = (doc, id) => (Array.isArray(doc.weeks) ? doc.weeks : []).find((w) => w && w.id === id) || null;

/** Is this sample usable? No incentive leg, and no effect created or acked, around it. */
function quietAt(s, legs, effects) {
  const lo = (s.at - QUIET_BEFORE_S) * 1000, hi = (s.at + QUIET_AFTER_S) * 1000;
  if (legs.some((l) => Number(l.ts) >= lo && Number(l.ts) <= hi)) return false;
  return !(effects || []).some((e) => (Number(e.created) >= lo && Number(e.created) <= hi) || (e.acked_at && Number(e.acked_at) >= lo && Number(e.acked_at) <= hi));
}
function pickSample(samples, data) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i], age = data.nowMs / 1000 - s.at;
    if (s.week !== data.eid || age < QUIET_AFTER_S || age > SAMPLE_MAX_AGE_S) continue;
    if (quietAt(s, data.legs, data.effects)) return s;
  }
  return null;
}
/**
 * One comparison (pure). data: {legs, doc, effects, inp, c, hour, eid, nowMs}; s: a ring sample.
 * -> {clean, drift, site, pepe, pending, carry, budgets, remaining, unmapped, stuck, list}
 */
function compare(s, data) {
  const { legs, doc, effects, inp, c, hour, eid, nowMs } = data;
  const startS = E.weekStart(s.at, hour), startMs = startS * 1000, cutMs = s.at * 1000;
  const cur = siteWeek(legs, { fromMs: startMs, toMs: startMs + E.WEEK * 1000, cutMs, doc, nowMs });
  const seen = doc.site_spends && typeof doc.site_spends === "object" ? doc.site_spends : {};
  const pending = {};
  for (const e of effects || []) {
    if (e.acked_at || hasOwn(seen, e.key) || !e.data || e.data.week !== eid) continue;
    pending[e.data.group] = (pending[e.data.group] || 0) + int(e.data.amount);
  }
  let drift = driftOf(s.spent, cur.spent, pending);
  // the boundary: last week's closed record against last week's legs
  const prevId = E.epochId(startS - 1, hour);
  const pw = weekDoc(doc, prevId);
  let carry = {};
  if (pw && Object.values(drift).some(Boolean)) {
    const prev = siteWeek(legs, { fromMs: startMs - E.WEEK * 1000, toMs: startMs, doc, nowMs });
    carry = explainCarry(drift, driftOf(pw.spent || {}, prev.spent), boundaryCandidates(cur.events, startMs));
  }
  const site = Object.assign({}, cur.spent);
  for (const [g, x] of Object.entries(carry)) { site[g] = int(site[g]) + x.amount; drift[g] = 0; }
  // Pepe's budgets and capped "remaining" against what the site would compute from the same settings
  // (his "remaining" doesn't include the effects he hasn't applied yet, so they come off the site's sum here)
  const seenByPepe = Object.fromEntries(E.GROUPS.map((g) => [g, Math.max(0, int(site[g]) - int(pending[g]))]));
  const week = { id: eid, budgets: {}, spent: seenByPepe, share: null, release_per_day: null };
  const si = Object.assign({}, inp, { week });
  const rw = E.resolveWeek(si, c, s.at);
  const budgets = {}, remaining = {}, left = {};
  for (const g of E.GROUPS) {
    left[g] = E.budgetLeft(si, c, g, s.at);
    if (int(rw.budgets[g]) !== int(s.budgets[g])) budgets[g] = [int(rw.budgets[g]), int(s.budgets[g])];
    if (int(rw.budgets[g]) >= 0 && int(left[g]) !== int(s.remaining[g])) remaining[g] = [int(left[g]), int(s.remaining[g])];
  }
  const list = [];
  for (const [g, d] of Object.entries(nonZero(drift))) list.push(`spent.${g}: site ${int(site[g])} / pepe ${int(s.spent[g])}${pending[g] ? ` + ${pending[g]} pending` : ""} (drift ${d})`);
  for (const [g, x] of Object.entries(budgets)) list.push(`budget.${g}: site ${x[0]} / pepe ${x[1]}`);
  for (const [g, x] of Object.entries(remaining)) list.push(`remaining.${g}: site ${x[0]} / pepe ${x[1]}`);
  for (const u of cur.unmapped.slice(0, 8)) list.push(`unmapped leg ${u.key}: ${u.why || u.flow} ${u.amount}`);
  for (const id of cur.stuck.slice(0, 8)) list.push(`claim ${id} stayed unsure past the grace period`);
  return { clean: !list.length, drift, site, pepe: s.spent, pending, carry, budgets, remaining, left, unmapped: cur.unmapped, stuck: cur.stuck, inflight: cur.inflight, list };
}
/** The closed week `id` (pure): Pepe's weeks[] entry against the legs of its [start, end); the boundaries' carries both ways. */
function compareClosed(id, data) {
  const { legs, doc, hour, nowMs } = data;
  const pw = weekDoc(doc, id);
  if (!pw) return null;
  const startS = Date.parse(id.slice(1) + "T00:00:00Z") / 1000 + hour * 3600, startMs = startS * 1000, endMs = startMs + E.WEEK * 1000;
  const cur = siteWeek(legs, { fromMs: startMs, toMs: endMs, doc, nowMs });
  const drift = driftOf(pw.spent || {}, cur.spent);
  const notes = [];
  // what ran across its END boundary: the next week's legs explain it (that week's drift is the mirror image once it is closed too)
  const next = siteWeek(legs, { fromMs: endMs, toMs: endMs + E.WEEK * 1000, doc, nowMs });
  const nextDoc = weekDoc(doc, E.epochId(endMs / 1000, hour));
  const nextW = nextDoc || (doc.week && doc.week.id === E.epochId(endMs / 1000, hour) ? doc.week : null);
  if (nextW) {
    const nd = driftOf(nextW.spent || {}, next.spent);
    for (const [g, x] of Object.entries(explainCarry(nd, drift, boundaryCandidates(next.events, endMs)))) { drift[g] = 0; notes.push(`${g}: ${-x.amount} counted before the end boundary, leg after it (${x.legs.join(", ")})`); }
  }
  // ... and across its START boundary: its own first legs against the week before
  const before = weekDoc(doc, E.epochId(startS - 1, hour));
  if (before) {
    const pd = driftOf(before.spent || {}, siteWeek(legs, { fromMs: startMs - E.WEEK * 1000, toMs: startMs, doc, nowMs }).spent);
    for (const [g, x] of Object.entries(explainCarry(drift, pd, boundaryCandidates(cur.events, startMs)))) { drift[g] = 0; notes.push(`${g}: ${x.amount} carried over the start boundary (${x.legs.join(", ")})`); }
  }
  const list = Object.entries(nonZero(drift)).map(([g, d]) => `spent.${g}: site ${int(cur.spent[g])} / pepe ${int((pw.spent || {})[g])} (drift ${d})`);
  for (const u of cur.unmapped.slice(0, 8)) list.push(`unmapped leg ${u.key}: ${u.why || u.flow} ${u.amount}`);
  return { clean: !list.length, drift, site: cur.spent, pepe: pw.spent || {}, notes, list, unmapped: cur.unmapped };
}

// ── reading the database (one short transaction: the connection is shared) ──
async function readData(nowMs, nowS) {
  const K = await B().weekCtx(nowS);
  const start = E.weekStart(nowS, K.hour) * 1000;
  const raw = await tx(async () => ({
    legs: await getQuery(`SELECT l.move_key, l.amount, l.ts, m.kind, m.flow, m.why FROM pool_move_legs l JOIN pool_moves m ON m.key = l.move_key
                          WHERE l.pool = 'incentives' AND l.ts >= ? AND l.ts <= ? ORDER BY l.ts, l.rowid`, [start - 2 * E.WEEK * 1000, nowMs + 60000]),
    doc: (await getQuery("SELECT doc FROM econ_docs WHERE name = 'econ_treasury'"))[0] || null,
    effects: await getQuery("SELECT key, data, created, acked_at FROM policy_effects WHERE kind = 'budget_spend'"),
  }));
  let doc = {};
  try { doc = (raw.doc && JSON.parse(raw.doc.doc)) || {}; } catch (e) { doc = {}; }
  const effects = raw.effects.map((e) => Object.assign(e, { data: C.parse(e.data, {}) }));
  return { legs: raw.legs, doc, effects, inp: K.inp, c: K.c, hour: K.hour, eid: K.eid, nowMs };
}

// ── the rows ──
const rowKey = (period) => `shadow:budget:${period}`;
async function putRow(period, f) {
  const t = Date.now();
  await runQuery(`INSERT INTO policy_sims (key, mode, engine, period, site_inputs, site_plan, pepe_plan, total_diff, whitelisted, blocking, ok, boundary_ts, created, updated)
                  VALUES (?, 'shadow', 'budget', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET site_inputs = excluded.site_inputs, site_plan = excluded.site_plan, pepe_plan = excluded.pepe_plan, total_diff = excluded.total_diff,
                    whitelisted = excluded.whitelisted, blocking = excluded.blocking, ok = excluded.ok, boundary_ts = excluded.boundary_ts, updated = excluded.updated
                  WHERE policy_sims.ok IS NULL`,
                 [rowKey(period), period, JSON.stringify(f.site_inputs || {}), JSON.stringify(f.site_plan === undefined ? null : f.site_plan),
                  JSON.stringify(f.pepe_plan === undefined ? null : f.pepe_plan), JSON.stringify(f.total_diff || []), JSON.stringify({ plan: f.notes || [] }),
                  JSON.stringify({ plan: f.blocking || [] }), f.ok === undefined ? null : f.ok, f.boundary_ts === undefined ? null : f.boundary_ts, t, t]);
}
async function getRow(period) {
  const r = (await getQuery("SELECT * FROM policy_sims WHERE key = ?", [rowKey(period)]))[0];
  return r ? Object.assign(r, { site_inputs: C.parse(r.site_inputs, {}) || {}, site_plan: C.parse(r.site_plan, null), pepe_plan: C.parse(r.pepe_plan, null),
                               total_diff: C.parse(r.total_diff, []), notes: (C.parse(r.whitelisted, {}) || {}).plan || [], blocking: (C.parse(r.blocking, {}) || {}).plan || [] }) : null;
}
async function closeOpenDays(did) {
  const open = await getQuery("SELECT period FROM policy_sims WHERE engine = 'budget' AND ok IS NULL AND period LIKE 'D%' AND length(period) = ? AND period < ? ORDER BY period",
                              [String(did).length, String(did)]);
  for (const { period } of open) {
    const r = await getRow(period);
    if (!r || r.ok !== null) continue;
    const si = r.site_inputs || {};
    const why = (si.attempts || []).length ? "no clean attempt" : "no quiet sample";
    await putRow(period, { site_inputs: Object.assign({}, si, { final: why }), site_plan: r.site_plan, pepe_plan: r.pepe_plan, total_diff: r.total_diff, notes: r.notes,
                           blocking: r.blocking.length ? r.blocking : [why], ok: 0, boundary_ts: r.boundary_ts });
    console.warn(`[budget] shadow ${period}: NOT clean (${why})`);
  }
}
const planOf = (s, x, eid) => ({ site: { week: eid, spent: x.site, budgets: undefined, left: x.left }, pepe: { week: s.week, spent: s.spent, budgets: s.budgets, remaining: s.remaining, share: s.share, release_per_day: s.release_per_day } });
const attemptRec = (s, x, nowMs) => Object.assign({ at: Math.round(nowMs / 1000), sample_at: Math.round(s.at), drift: nonZero(x.drift), pending: x.pending, unmapped: x.unmapped.length },
                                                  Object.keys(x.carry).length ? { carry: x.carry } : {}, x.inflight ? { inflight: x.inflight } : {}, x.stuck.length ? { stuck_unsure: x.stuck.slice(0, 20) } : {});

async function closedWeekPass(eid, data) {
  const prevId = E.epochId(E.weekStart(data.nowMs / 1000, data.hour) - 1, data.hour);
  const r = await getRow(prevId);
  if (r && r.ok !== null) return null;
  const x = compareClosed(prevId, data);
  if (!x) return null;
  await putRow(prevId, { site_inputs: { unmapped: x.unmapped.slice(0, 20) }, site_plan: { week: prevId, spent: x.site }, pepe_plan: { week: prevId, spent: x.pepe }, total_diff: x.list,
                         notes: x.notes, blocking: x.list, ok: x.clean ? 1 : 0 });
  if (!x.clean) console.warn(`[budget] shadow ${prevId}: NOT clean: ${x.list.slice(0, 4).join(" | ")}`);
  return `budget week ${prevId}: ${x.clean ? "clean" : "NOT clean"}`;
}

/**
 * The scheduler's pass (policy/scheduler.js): reads and writes only its own rows; never throws. Skipped while a staging test clock is set
 * and the pass has no tag; only while Pepe owns the week; 05:00 - 03:30 UTC, after the day's runs (and the epoch, on its day); one
 * attempt per 15 minutes, at most 60 a day. -> a line for the log, or null.
 */
async function pass(nowS, info, engs) {
  try {
    if (C._testOffset() !== 0 && !info.sfx) return null;
    if ((await B().ownerRow()).owner !== "pepe") return null;
    await B().init();
    await closeOpenDays(info.did);
    if (nowS < info.db + START_S || nowS >= info.db + END_S) return null;
    const due = [["treasury", info.did], ["monetary", info.did]];
    if (info.db === info.eb) due.push(["treasury", info.eid]);
    for (const [eng, period] of due) {
      if (!engs || !engs[eng] || engs[eng].mode !== "live") continue;
      const run = await C.run(eng, period);
      if (!run || !["done", "handed", "missed"].includes(run.state)) return null;
    }
    const did = info.did;
    const nowMs = clock();
    if (nowMs / 1000 - lastAttemptAt < ATTEMPT_EVERY_S) return null;
    lastAttemptAt = nowMs / 1000;
    const data = await readData(nowMs, nowMs / 1000);
    const closed = await closedWeekPass(data.eid, data);
    if (doneDays.has(did)) return closed;
    let row = await getRow(did);
    if (row && row.ok !== null) { doneDays.add(did); return closed; }
    if (!row) {
      await putRow(did, { site_inputs: { eligible: nowMs / 1000, attempts: [] } });
      row = await getRow(did);
    }
    const si = row.site_inputs || {};
    const attempts = Array.isArray(si.attempts) ? si.attempts : [];       // the newest 20, for the card
    const made = Number(si.n) || attempts.length;
    if (made >= MAX_ATTEMPTS) return closed;
    const s = pickSample(ring, data);
    if (!s) return closed;
    if (attempts.some((a) => a.sample_at === Math.round(s.at))) return closed;
    const x = compare(s, data);
    const ok = x.clean ? 1 : null;
    const plan = planOf(s, x, data.eid);
    plan.site.budgets = E.resolveWeek(Object.assign({}, data.inp, { week: { id: data.eid, budgets: {}, spent: x.site } }), data.c, s.at).budgets;
    await putRow(did, { site_inputs: Object.assign({}, si, { attempts: attempts.concat(attemptRec(s, x, nowMs)).slice(-20), n: made + 1, carry: x.carry, stuck_unsure: x.stuck.slice(0, 20) }),
                        site_plan: plan.site, pepe_plan: plan.pepe, total_diff: x.list,
                        notes: Object.entries(x.carry).map(([g, c]) => `${g}: carry ${c.amount} over the Monday boundary (${c.legs.join(", ")})`),
                        blocking: x.list, ok, boundary_ts: s.at });
    if (ok) doneDays.add(did);
    return `budget ${did}: ${x.clean ? "clean" : `differs (${x.list.length})`}`;
  } catch (e) {
    console.error("[budget] shadow:", e.message);
    return null;
  }
}

// ── reading the results ──
async function latest() {
  const r = (await getQuery("SELECT period, ok, blocking, boundary_ts, updated FROM policy_sims WHERE engine = 'budget' AND period LIKE 'D%' ORDER BY period DESC LIMIT 1").catch(() => []))[0];
  return r ? { day: r.period, ok: r.ok === null ? null : !!r.ok, at: r.boundary_ts, blocking: (C.parse(r.blocking, {}) || {}).plan || [] } : null;
}
async function view() {
  const mk = (r) => {
    const si = C.parse(r.site_inputs, {}) || {};
    return { period: r.period, ok: r.ok === null ? null : !!r.ok, blocking: ((C.parse(r.blocking, {}) || {}).plan || []).slice(0, 10), notes: (C.parse(r.whitelisted, {}) || {}).plan || [],
             attempts: si.n || (si.attempts || []).length, final: si.final || null, at: r.boundary_ts, updated: r.updated };
  };
  const dayRows = await getQuery("SELECT * FROM policy_sims WHERE engine = 'budget' AND period LIKE 'D%' ORDER BY period DESC LIMIT 14");
  const weekRows = await getQuery("SELECT * FROM policy_sims WHERE engine = 'budget' AND period LIKE 'W%' ORDER BY period DESC LIMIT 4");
  const days = dayRows.map(mk), weeks = weekRows.map(mk);
  let streak = 0;
  for (const d of days) { if (d.ok === null && streak === 0) continue; if (d.ok !== true) break; streak++; }
  const top = dayRows[0] || null;
  let groups = [], latestRow = null, unmapped = [];
  if (top) {
    const sp = C.parse(top.site_plan, null), pp = C.parse(top.pepe_plan, null), si = C.parse(top.site_inputs, {}) || {};
    latestRow = { day: top.period, ok: top.ok === null ? null : !!top.ok, at: top.boundary_ts, sample_age_s: top.boundary_ts ? Math.round(clock() / 1000 - top.boundary_ts) : null };
    const last = (si.attempts || [])[(si.attempts || []).length - 1] || {};
    unmapped = last.unmapped ? ((C.parse(top.blocking, {}) || {}).plan || []).filter((x) => /^unmapped/.test(x)) : [];
    if (sp && pp) {
      groups = E.GROUPS.map((g) => ({ group: g, budget: int((pp.budgets || {})[g]), pepe_spent: int((pp.spent || {})[g]), site_spent: int((sp.spent || {})[g]),
                                      drift: int((pp.spent || {})[g]) - int((sp.spent || {})[g]) + int((last.pending || {})[g]), left: int((sp.left || {})[g]), remaining: int((pp.remaining || {})[g]) }));
    }
  }
  return { week: { id: top && C.parse(top.pepe_plan, null) ? C.parse(top.pepe_plan, null).week : null }, groups, latest: latestRow, streak, days, weeks, unmapped, samples: ring.length };
}

module.exports = { noteSync, classifyLeg, siteWeek, subsetSum, boundaryCandidates, explainCarry, driftOf, quietAt, pickSample, compare, compareClosed, readData, pass, latest, view,
                   getRow, putRow, closeOpenDays, RING_MAX, QUIET_BEFORE_S, QUIET_AFTER_S, SAMPLE_MAX_AGE_S, ATTEMPT_EVERY_S, MAX_ATTEMPTS, START_S, END_S, UNSURE_GRACE_MS, BAND_S,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _ring: () => ring,
                   _reset: () => { ring.length = 0; lastAttemptAt = 0; doneDays.clear(); clock = () => Date.now(); } };
