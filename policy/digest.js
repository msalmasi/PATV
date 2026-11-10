// policy/digest.js — PO-4 of the economy policy -> site plan ("Phase 6"): the weekly staking AUDIT and DIGEST of a settled epoch,
// ported from Pepe (camfrog-bot pepe_treasury._tr_audit / _tr_digest / _tr_stash_payouts / the remote branch of
// _tr_conservation_base, pepe_corrections._corr_digest_line) expression for expression - and every Python format spec with it
// (f"{n:,}", ":g", ".0f" / ".1f" / ",.0f" half-even on the exact double; len() and [:n] by code points). Proven by camfrog-bot
// tools/gen_derived_vectors.py sections B (p31) and C (audit) -> test/policy-derived-vectors.test.js, 0 differences.
//
// Pepe's labels (his record's checks, named by check here, not by I-number - his I6 / I7 / I9 differ from capital/watch.js's):
//   legs never landed · payouts refused by the site · the legs out of a vault vs its surplus (his "I9": the epoch's own
//   conservation) · the stakers' legs vs the plan · stakers paid more than min(their share, the cap) (the track vs the cap) · the
//   per-stash re-split from the book · the legs took > 15 min · a paid stash with no payout notice (the brief's "I6 notices") ·
//   info: the bind ratio, the pools before / after (P3.1: House + the pools the legs touch + the stash legs that landed), the
//   payout's own APR over 100%, D2's reference cap (fallback)
//
// TWO USES (1.99aju):
//   SHADOW (now - via "shadow"): digestPass (policy/scheduler.js pass()) audits PEPE's settled record, rebuilt from what the site
//     already holds - his plan (policy_sims "shadow:treasury:<eid>".pepe_plan / pepe_inputs), the legs that landed (stash_moves /
//     pool_moves "<tid>:in", bot_credit_log "vl:<tid>:in"), the refused stash legs (a "refused" stash move + its "<tid>:back"),
//     the payout notices (inbox / inbox_pending ref "wf:<eid>:s<stash>"), his settled time (capital cfg wf_settled) and the track
//     (engines.trackOf) - and compares the notice + digest it WOULD send with Pepe's own inbox rows (ref "wf-audit:<eid>" /
//     "wf-digest:<eid>"). It SENDS NOTHING: no inbox row, no opsalerts call, no policy_effects row, no PAT.
//   LIVE (dormant until the treasury engine is live, H2a): policy/apply.js runTreasuryEpoch calls afterEpoch(eid, res) once its
//     settlement committed - the audit notice (problems only) and the digest (track.pool > 0) to every Pepe-owner account's inbox
//     (Pepe's exact title / text, link /admin/economy, refs wf-audit:<eid> / wf-digest:<eid>) + opsalerts (source "staking-digest").
//     Once per eid (the inbox's one row per (user, ref), opsalerts per ref, audit_sent_at / digest_sent_at set once it went out);
//     the scheduler's retry covers a crash between the commit and the digest, or mid-send (7 days, Pepe's rule). Not PAT.
//   policy_epoch_audit   eid PK, via (shadow | site), state (pending | final), audit {problems, info, bind, na}, notice / digest
//                        ({title, text} | null: what the site would send / sent), pepe {audit_title, audit_body, digest_title,
//                        digest_body, seen_at} (shadow), audit_match / digest_match (1 = Pepe's, 0 = not, null = not compared
//                        yet), audit_sent_at / digest_sent_at (live), created, updated (ms)
"use strict";
const E = require("./engines");
const { pyRoundN } = require("./pymath");

const pyInt = E.pyInt;
const fmt = E.fmt;
const TREASURY = ["house", "bank", "mm"];
const TR_WEEKLY_POOLS = ["reserve", "incentives", "bank", "mm"];         // pepe_treasury.TR_WEEKLY_POOLS (FED, INCENTIVES, ...)
const TR_DAILY_POOLS = ["reserve", "incentives", "fortknox", "heist"];   // TR_DAILY_POOLS (FED, INCENTIVES, FORTKNOX, CASINO)
const TR_VAULT_LABEL = { house: "🎰 House", bank: "🏦 Bank", mm: "📈 Market maker" };
const AUDIT_LAND_SECS = 900;
const AUDIT_BIND_WARN = 0.25;
const TR_APR_WARN = 1.0;
const TEXT_MAX = 590;                       // the notices' text cut (Pepe: [:590]; notify_user then strips and keeps [:600])
const TITLE_MAX = 120;
const SHADOW_WAIT_S = 600;                  // Pepe's notices are pushed async: compare at least this long after his done
const SHADOW_FINAL_S = 2 * 3600;            // ...and final this long after it (a row still missing = he sent none)
const SHADOW_EVERY_S = 60;                  // review of PO-4: a pending audit is rebuilt at most this often (not on every 15 s pass)
const RETRY_DAYS = 7;                       // the live retry: a site-run record with no audit, within 7 days (Pepe's rule)
// notify_user to his own login sends nothing but counts as sent. 1.99?? (account rotation): every login Pepe has had (pepelogins.js) -
// the same set as the bot's _pepe_accounts() (known accounts + configured + former logins), so the shadow compares agree
const PL = require("../pepelogins");
const ALINE_MARK = " 🔎 Staking audit: ";

// ── Python's formatting (exact) ──
/** The exact decimal expansion of a finite double: |x| = digits / 10^scale. */
function exact(x) {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const neg = !!(hi >>> 31);
  const ex = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2;
  if (ex === 0) e2 = -1074; else { mant |= 1n << 52n; e2 = ex - 1075; }
  if (e2 >= 0) return { neg, digits: mant << BigInt(e2), scale: 0 };
  return { neg, digits: mant * 5n ** BigInt(-e2), scale: -e2 };
}
/** digits / 10^drop rounded half-even to an integer (BigInt); a negative drop scales up. */
function roundDrop(digits, drop) {
  if (drop <= 0) return digits * 10n ** BigInt(-drop);
  const p = 10n ** BigInt(drop);
  let q = digits / p;
  const r = digits - q * p;
  if (2n * r > p || (2n * r === p && q % 2n === 1n)) q += 1n;
  return q;
}
const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** format(x, ".{n}f") / format(x, ",.{n}f") (comma): fixed point, half-even on the exact value (JS toFixed is not). */
function fixed(x, n = 0, comma = false) {
  x = Number(x);
  if (!Number.isFinite(x)) return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  const e = exact(x);
  const q = roundDrop(e.digits, e.scale - n);
  const neg = e.neg ? "-" : "";
  const s = q.toString().padStart(n + 1, "0");
  const ip = n ? s.slice(0, s.length - n) : s, fp = n ? s.slice(s.length - n) : "";
  return neg + (comma ? group(ip) : ip) + (n ? "." + fp : "");
}
/** format(x, "g"): 6 significant digits half-even on the exact value, trailing zeros dropped, the exponent form when the
 *  exponent is < -4 or >= 6. */
function fmtG(x, p = 6) {
  x = Number(x);
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const e = exact(x);
  const s0 = e.digits.toString();
  let e10 = s0.length - 1 - e.scale;
  let q = roundDrop(e.digits, s0.length - p);
  if (q.toString().length > p) { e10 += 1; q = roundDrop(q, 1); }
  const qs = q.toString().padStart(p, "0");
  let out;
  if (e10 < -4 || e10 >= p) {
    const m = (qs[0] + "." + qs.slice(1)).replace(/\.?0+$/, "");
    out = `${m}e${e10 < 0 ? "-" : "+"}${String(Math.abs(e10)).padStart(2, "0")}`;
  } else if (e10 >= 0) {
    const ip = qs.slice(0, e10 + 1), fp = qs.slice(e10 + 1).replace(/0+$/, "");
    out = fp ? `${ip}.${fp}` : ip;
  } else {
    out = "0." + ("0".repeat(-e10 - 1) + qs).replace(/0+$/, "");
  }
  return (e.neg ? "-" : "") + out;
}
/** len(s) / s[a:b] by code points (Python str; '🏛️' is 2 code points, 3 UTF-16 units). */
const cpLen = (s) => Array.from(String(s)).length;
const cpSlice = (s, a, b) => Array.from(String(s)).slice(a, b).join("");
/** str(x) of a JSON value as Python prints it. */
const pyStr = (x) => (x === null || x === undefined ? "None" : x === true ? "True" : x === false ? "False" : String(x));
/** Python's str.strip() (whitespace both ends). */
const pyStrip = (s) => String(s).replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/gu, "");
const has = (o, k) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const cmpPy = E.cmpPy;
const num = (x) => (x === null || x === undefined || x === "" ? 0 : Number(x));
const label = (v) => (has(TR_VAULT_LABEL, v) ? TR_VAULT_LABEL[v] : pyStr(v));

// ── the pure ports ──
/** pepe_treasury._tr_stash_payouts: {stash id: {total, vaults: {vault: PAT}}} - the stakers' legs of a record that landed. */
function stashPayouts(rec) {
  const done = new Set(rec.done_legs || []);
  const out = new Map();
  for (const leg of rec.legs || []) {
    const dst = pyStr(leg.dst === undefined || leg.dst === null || leg.dst === "" ? "" : leg.dst);
    if (leg.why !== "waterfall stakers" || !dst.startsWith("stash:") || !done.has(leg.tid)) continue;
    const id = dst.slice(6);
    if (!out.has(id)) out.set(id, { total: 0, vaults: new Map() });
    const x = out.get(id);
    x.total += pyInt(leg.amt);
    const v = leg.vault === undefined ? null : leg.vault;
    x.vaults.set(v, (x.vaults.has(v) ? x.vaults.get(v) : 0) + pyInt(leg.amt));
  }
  return out;
}
/** The remote branch of pepe_treasury._tr_conservation_base (fix-plan P3.1): the House + the pools the legs touch (`pools`: the
 *  weekly TR_WEEKLY_POOLS by default, the daily TR_DAILY_POOLS) + the stash legs of `rec` that landed. balances: {jackpot, reserve,
 *  incentives, bank, mm, fortknox, heist} (PAT). */
function p31Base(balances, rec, pools) {
  const bal = balances || {};
  let base = pyInt(bal.jackpot);
  for (const k of (Array.isArray(pools) && pools.length ? pools : TR_WEEKLY_POOLS)) base += pyInt(bal[k]);
  if (rec && typeof rec === "object" && Object.keys(rec).length) {
    const done = new Set(rec.done_legs || []);
    for (const l of rec.legs || []) {
      const dst = l.dst === undefined || l.dst === null || l.dst === "" ? "" : pyStr(l.dst);
      if (dst.startsWith("stash:") && done.has(l.tid)) base += pyInt(l.amt);
    }
  }
  return base;
}
/**
 * pepe_treasury._tr_audit(rec): {problems, info, bind}. `stakers(v, prices, boundary, lastBoundary, days)` -> the per-stash split
 * the book gives now ([[id, value], ...] or a Map, in the book's order; pepe_treasury._tr_stakers = policy/engines stakers on the
 * epoch's inputs); `lastBoundary` = _tr_last_boundary(eid); `now` = time.time() for a record without done / ts. The group "stash X
 * was paid ... but holds no stake there" comes from a Python set (its order follows the hash seed): emitted sorted here, compared
 * as a multiset (matchAudit).
 */
function auditRecord(rec, { stakers = null, lastBoundary = 0, now = null } = {}) {
  const eid = rec.epoch;
  const problems = [], info = [], bind = {};
  const done = new Set(rec.done_legs || []);
  const refused = rec.refused_legs && typeof rec.refused_legs === "object" ? rec.refused_legs : {};
  const legs = rec.legs || [];
  const pending = legs.filter((l) => !done.has(l.tid) && !has(refused, l.tid)).map((l) => pyStr(l.tid));
  if (pending.length) problems.push(`${pending.length} leg(s) never landed: ${pending.slice(0, 4).join(", ")}`);
  const rv = Object.values(refused);
  if (rv.length) {
    problems.push(`${rv.length} staking payout(s) refused by the site and returned to their vault: `
                  + rv.slice(0, 4).map((x) => `stash ${pyStr((x || {}).stash)} ${fmt(pyInt((x || {}).amount || 0))} (${pyStr((x || {}).error)})`).join(", "));
  }
  const paidV = new Map(), outV = new Map();
  for (const l of legs) {
    const v = l.vault === undefined ? null : l.vault;
    outV.set(v, (outV.has(v) ? outV.get(v) : 0) + pyInt(l.amt || 0));
    if (l.why === "waterfall stakers" && done.has(l.tid)) paidV.set(v, (paidV.has(v) ? paidV.get(v) : 0) + pyInt(l.amt));
  }
  let prices = null;
  for (const [v, x] of Object.entries(rec.vaults || {})) {
    const pool = pyInt(x.stakers_share || 0), cap = pyInt(x.apr_cap || 0), stk = pyInt(x.stakers || 0);
    const give = Math.min(pool, cap);
    const surplus = pyInt(x.surplus || 0);
    const moved = outV.has(v) ? outV.get(v) : 0;
    if (moved !== surplus) problems.push(`${v}: the legs move ${fmt(moved)}, its surplus is ${fmt(surplus)}`);
    const paid0 = paidV.has(v) ? paidV.get(v) : 0;
    if (paid0 !== stk) problems.push(`${v}: the stakers' legs paid ${fmt(paid0)}, the plan says ${fmt(stk)}`);
    if (stk > give) problems.push(`${v}: stakers paid ${fmt(stk)}, more than min(their 20% ${fmt(pool)}, the cap ${fmt(cap)})`);
    if (pool > 0) {
      bind[v] = pyRoundN(stk / pool, 4);
      if (stk / pool < AUDIT_BIND_WARN) info.push(`${v}: stakers got ${fixed(stk / pool * 100, 1)}% of their ${fmt(pool)} share (the APR cap binds)`);
    }
    if (give > 0 && pyInt(x.staked || 0) > 0) {
      if (prices === null) prices = Object.fromEntries(TREASURY.map((k) => [k, Number(((rec.vaults || {})[k] || {}).price || 0)]));
      let st = [];
      try {
        const got = stakers ? stakers(v, prices, rec.boundary === undefined ? null : rec.boundary, lastBoundary, rec.days === undefined ? null : rec.days) : [];
        st = got instanceof Map ? [...got.entries()] : Array.isArray(got) ? got : Object.entries(got || {});
      } catch (e) { st = []; }
      let staked = 0;
      for (const [, val] of st) staked += Number(val);
      if (st.length && Math.abs(staked - pyInt(x.staked)) <= Math.max(2.0, st.length)) {
        const paid = new Map();
        for (const l of legs) if (l.vault === v && l.why === "waterfall stakers") paid.set(pyStr(l.dst).slice(6), pyInt(l.amt));
        const ids = new Set();
        for (const [vid, val] of st) {
          ids.add(vid);
          const want = pyInt(give * Number(val) / staked);
          const got = paid.has(vid) ? paid.get(vid) : 0;
          if (Math.abs(got - want) > 1) problems.push(`${v}: stash ${vid} was paid ${fmt(got)}, its share is ${fmt(want)}`);
        }
        for (const vid of [...paid.keys()].filter((id) => !ids.has(id)).sort(cmpPy)) {
          problems.push(`${v}: stash ${vid} was paid ${fmt(paid.get(vid))} but holds no stake there`);
        }
      } else {
        info.push(`${v}: the book changed since the plan - the per-stash split wasn't re-checked`);
      }
    }
  }
  const t = now === null || now === undefined ? Date.now() / 1000 : Number(now);
  const dn = num(rec.done) || t;
  const took = dn - (num(rec.ts) || num(rec.done) || t);
  if (took > AUDIT_LAND_SECS) problems.push(`the legs took ${fixed(took / 60, 0)} min to land (a restart mid-epoch, or the House / the site didn't answer)`);
  const notified = rec.notified && typeof rec.notified === "object" ? rec.notified : {};
  const unsent = [...stashPayouts(rec)].filter(([vid, x]) => x.total > 0 && !has(notified, vid)).map(([vid]) => vid);
  if (unsent.length) problems.push(`${unsent.length} paid stash(es) got no payout notice: ${unsent.slice().sort(cmpPy).slice(0, 6).join(", ")}`);
  if (rec.conserved === false) {
    info.push(`pools before ${fmt(rec.pools_before || 0)} != after ${fmt(rec.pools_after || 0)} `
              + `(off by ${fmt(pyInt(rec.pools_after || 0) - pyInt(rec.pools_before || 0))}: other activity during the run)`);
  }
  for (const [v, x] of Object.entries(((rec.track || {}).vaults) || {})) {
    if (num(x.payout_apr) > TR_APR_WARN) info.push(`${v}: the payout alone was ${fixed(Number(x.payout_apr) * 100, 0, true)}% APR on the stakers' stake`);
    if (x.fallback) {
      info.push(`${v}: no weekly cap, but not a full week of time-weighting (${pyStr(x.weighting)}): paid under the ${fmtG(E.TR_FALLBACK_CAP * 100)}% reference cap`);
    }
  }
  return { problems, info, bind };
}
/** _tr_audit's admin notice (problems only) -> {title, text} | null. */
function auditNotice(eid, problems) {
  if (!problems || !problems.length) return null;
  return { title: `Staking audit ${pyStr(eid)}: ${problems.length} problem(s)`,
           text: cpSlice(`🏛️ Staking payouts ${pyStr(eid)}: ${problems.length} problem(s) - ` + problems.join(" | "), 0, TEXT_MAX) };
}
/**
 * pepe_treasury._tr_digest(rec) -> {title, text} | null (no track, or no vault had a stakers' pool). `aline` = the replay audit's
 * one line (pepe_corrections._corr_digest_line; "" until PO-8 on the site): kept whole when the text is cut to the notice's length.
 */
function digestOf(rec, aline = "") {
  const tr = rec && rec.track;
  if (!tr || rec.digest_sent || pyInt(tr.pool || 0) <= 0) return null;
  const eid = rec.epoch;
  const cap = num(tr.cap_in_force_pct);
  const vaults = tr.vaults || {};
  const ref = fmtG(Number(tr.ref_cap_pct));
  const parts = Object.entries(vaults).filter(([, x]) => pyInt(x.pool || 0) > 0)
    .map(([v, x]) => `${label(v)} paid ${fmt(x.paid)} of ${fmt(x.pool)}, a ${ref}% cap: ${fmt(x.would25)}`).join(" · ");
  const wname = { pat_days: "PAT-days (time-weighted)", partial: "PAT-days that began mid-week", snapshot: "the Monday snapshot" };
  const tw = [...new Set(Object.values(vaults).filter((x) => pyInt(x.pool || 0) > 0).map((x) => (x.weighting === undefined ? null : x.weighting)))].sort(cmpPy);
  const hot = Object.entries(vaults).filter(([, x]) => num(x.payout_apr) > TR_APR_WARN).map(([v, x]) => [v, Number(x.payout_apr)]);
  const fb = Array.isArray(tr.fallback) ? tr.fallback.slice() : [];
  let text = `🏛️ Staking week ${pyStr(eid)}: stakers were paid ${fmt(tr.paid)} of their ${fmt(tr.pool)} share of the protocol's surplus (weekly cap: `
    + (cap > 0 ? `${fmtG(cap)}% APR` : "none") + `). A ${ref}% APR cap would have paid ${fmt(tr.would25)}. ${parts}. Stakes weighted by `
    + (tw.map((w) => (has(wname, w) ? wname[w] : pyStr(w))).join(" / ") || "-") + "."
    + (fb.length ? " Capped at " + `${fmtG(E.TR_FALLBACK_CAP * 100)}% APR this week (not a full week of time-weighting): ` + fb.map(label).join(", ") + "." : "")
    + (hot.length ? " ⚠ the payout alone was " + hot.map(([v, a]) => `${label(v)} ${fixed(a * 100, 0, true)}% APR`).join(", ") + " on the stakers' stake." : "");
  if (aline) {
    const room = TEXT_MAX - cpLen(aline);
    text = (cpLen(text) <= room ? text : cpSlice(text, 0, Math.max(0, room - 1)) + "…") + aline;
  }
  return { title: `Staking week ${pyStr(eid)}: paid ${fmt(tr.paid)} (${ref}% cap: ${fmt(tr.would25)})` + (hot.length || fb.length ? " ⚠" : ""),
           text: cpSlice(text, 0, TEXT_MAX) };
}

// ── comparing with Pepe's inbox rows ──
/** A notice as the site's inbox stores it after Pepe's notify_user (str.strip(), [:600] / title [:120]) and inbox.js's clean
 *  (control characters -> " ", trimmed, 2000 / 160 UTF-16 units). */
const inboxClean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, n);
const storedBody = (text) => inboxClean(cpSlice(pyStrip(text || ""), 0, 600), 2000);
const storedTitle = (title) => inboxClean(cpSlice(pyStrip(title || ""), 0, TITLE_MAX), 160);
/** The site's digest text vs Pepe's stored body: his trailing replay-audit line (" 🔎 Staking audit: …") is split off and the site's
 *  digest re-rendered with it (`render(aline)` -> {text}), then compared exactly. -> true | false */
function matchDigest(render, pepeBody) {
  if (typeof pepeBody !== "string") return false;
  const i = pepeBody.indexOf(ALINE_MARK);
  const aline = i >= 0 ? pepeBody.slice(i) : "";
  const d = render(aline);
  return !!d && storedBody(d.text) === pepeBody;
}
/** The site's audit notice ({title, problems}) vs Pepe's stored row ({title, body}): the title exactly; the problems as a multiset
 *  (the set-order group); a text cut at 590 compares its last item as a prefix of one of the site's left. -> true | false */
function matchAudit(eid, problems, pepe) {
  const site = auditNotice(eid, problems);
  if (!site || !pepe) return !site && !pepe;
  if (storedTitle(site.title) !== String(pepe.title || "")) return false;
  const body = String(pepe.body || "");
  const head = storedBody(`🏛️ Staking payouts ${pyStr(eid)}: ${problems.length} problem(s) - `).trimEnd();
  if (!body.startsWith(head)) return false;
  const rest = body.slice(head.length).replace(/^\s+/, "");
  const items = rest.length ? rest.split(" | ") : [];
  const left = problems.map(String);
  const full = cpLen(site.text) >= TEXT_MAX;             // the text was cut: its last item may be a prefix
  for (let k = 0; k < items.length; k++) {
    const last = k === items.length - 1;
    let j = left.indexOf(items[k]);
    if (j < 0 && last && full) j = left.findIndex((p) => p.startsWith(items[k]));
    if (j < 0) return false;
    left.splice(j, 1);
  }
  return full ? true : left.length === 0;
}

// ── the I/O part ──
/** The table (policy_epoch_audit) is created by policy/core.js init. */
const init = () => require("./core").init();
const J = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { if (s == null) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
async function row(eid) {
  await init();
  const r = (await require("../dbUtils").getQuery("SELECT * FROM policy_epoch_audit WHERE eid = ?", [String(eid)]))[0];
  return r ? Object.assign(r, { audit: parse(r.audit, null), notice: parse(r.notice, null), digest: parse(r.digest, null), pepe: parse(r.pepe, null) }) : null;
}
/** Writes a row while it isn't final (a final row is never rewritten). */
async function putRow(eid, f) {
  await init();
  const { runQuery } = require("../dbUtils");
  const t = Date.now();
  await runQuery(`INSERT INTO policy_epoch_audit (eid, via, state, audit, notice, digest, pepe, audit_match, digest_match, created, updated)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(eid) DO UPDATE SET via = excluded.via, state = excluded.state, audit = excluded.audit, notice = excluded.notice,
                    digest = excluded.digest, pepe = excluded.pepe, audit_match = excluded.audit_match, digest_match = excluded.digest_match,
                    updated = excluded.updated WHERE policy_epoch_audit.state IS NOT 'final'`,
                 [String(eid), f.via, f.state, J(f.audit), J(f.notice), J(f.digest), J(f.pepe || null),
                  f.audit_match === undefined ? null : f.audit_match, f.digest_match === undefined ? null : f.digest_match, t, t]);
}

/** The legs of a plan that landed on the site ("<tid>:in": a stash move that isn't a refusal, a pool move, a House adjust "vl:<tid>:in"). */
async function landed(legs) {
  const { getQuery } = require("../dbUtils");
  const crypto = require("crypto");
  const q = async (sql, p) => { try { return (await getQuery(sql, p)).length > 0; } catch (e) { return false; } };
  const vlRef = (key) => { const r = `vl:${key}`; return r.length <= 80 ? r : "vl:" + crypto.createHash("sha256").update(String(key), "utf8").digest("hex").slice(0, 64); };
  const out = [];
  for (const l of legs || []) {
    const k = `${l.tid}:in`;
    if (await q("SELECT 1 FROM stash_moves WHERE key = ? AND kind != 'refused'", [k]) || await q("SELECT 1 FROM pool_moves WHERE key = ?", [k])
        || await q("SELECT 1 FROM bot_credit_log WHERE ref = ? AND outcome = 'ok'", [vlRef(k)])) out.push(l.tid);
  }
  return out;
}
/** Pepe's refused stash legs: a "refused" stash move under "<tid>:in" AND the "<tid>:back" move that returned its PAT. */
async function refusedOf(legs) {
  const { getQuery } = require("../dbUtils");
  const crypto = require("crypto");
  const out = {};
  for (const l of legs || []) {
    if (!String(l.dst || "").startsWith("stash:")) continue;
    let r;
    try { r = (await getQuery("SELECT result FROM stash_moves WHERE key = ? AND kind = 'refused'", [`${l.tid}:in`]))[0]; } catch (e) { r = null; }
    if (!r) continue;
    const bk = `${l.tid}:back`;
    const vl = `vl:${bk}`.length <= 80 ? `vl:${bk}` : "vl:" + crypto.createHash("sha256").update(bk, "utf8").digest("hex").slice(0, 64);
    let back = false;
    try {
      back = (await getQuery("SELECT 1 FROM pool_moves WHERE key = ?", [bk])).length > 0
        || (await getQuery("SELECT 1 FROM bot_credit_log WHERE ref = ? AND outcome = 'ok'", [vl])).length > 0;
    } catch (e) { back = false; }
    if (!back) continue;
    const res = parse(r.result, {}) || {};
    out[l.tid] = { stash: String(l.dst).slice(6), amount: pyInt(l.amt), src: l.src, vault: l.vault, code: res.code || null,
                   error: String(res.error || res.code || "refused").slice(0, 160) };
  }
  return out;
}
/** The paid stashes that got their payout notice (inbox / inbox_pending ref "wf:<eid>:s<id>"); a stash owned by Pepe's own login
 *  counts as notified (notify_user sends nothing to himself, but his record marks it sent). -> {id: true} */
async function notifiedOf(eid, ids) {
  const { getQuery } = require("../dbUtils");
  const out = {};
  for (const id of ids) {
    const ref = `wf:${eid}:s${id}`;
    let n = 0;
    for (const t of ["inbox", "inbox_pending"]) {
      try { n += Number(((await getQuery(`SELECT COUNT(*) AS n FROM ${t} WHERE ref = ?`, [ref]))[0] || {}).n || 0); } catch (e) { /* no table */ }
    }
    if (!n) {
      try { const s = await require("../stashes").get(id); if (s && PL.has(s.owner)) n = 1; } catch (e) { /* none */ }
    }
    if (n) out[id] = true;
  }
  return out;
}
/** Pepe's own notices for an eid: {audit: {title, body} | null, digest: ...} (any recipient, inbox or inbox_pending). */
async function pepeRows(eid) {
  const { getQuery } = require("../dbUtils");
  const one = async (ref) => {
    for (const t of ["inbox", "inbox_pending"]) {
      try {
        const r = (await getQuery(`SELECT title, body FROM ${t} WHERE ref = ? ORDER BY id LIMIT 1`, [ref]))[0];
        if (r) return { title: r.title || "", body: r.body || "" };
      } catch (e) { /* no table */ }
    }
    return null;
  };
  return { audit: await one(`wf-audit:${eid}`), digest: await one(`wf-digest:${eid}`) };
}
/** Pepe's settled time of an eid (capital cfg wf_settled: every done record of his push, tagged runs included) -> s | null. */
async function pepeDone(eid) {
  const c = (await require("../capital/core").meta("cfg")) || {};
  const r = require("../capital/vaults").settledFrom(c.wf_settled || []).find((x) => x.epoch === eid);
  return r ? (r.done || null) : null;
}

/** Rebuild Pepe's settled record of `eid` from the site's rows -> {rec, inputs} | null (no shadow report from him). */
async function pepeRecord(eid, doneS) {
  const { getQuery } = require("../dbUtils");
  const s = (await getQuery("SELECT pepe_plan, pepe_inputs FROM policy_sims WHERE key = ?", [`shadow:treasury:${eid}`]))[0];
  const plan = s ? parse(s.pepe_plan, null) : null;
  const inputs = s ? parse(s.pepe_inputs, null) : null;
  if (!plan || !Array.isArray(plan.legs)) return null;
  const rec = JSON.parse(JSON.stringify(plan));
  rec.state = "done";
  rec.done_legs = await landed(plan.legs);
  const refused = await refusedOf(plan.legs);
  if (Object.keys(refused).length) rec.refused_legs = refused;
  rec.done = doneS;
  try { if (inputs) rec.track = E.trackOf(inputs, plan); } catch (e) { /* no track: the digest says nothing */ }
  rec.notified = await notifiedOf(eid, [...stashPayouts(rec).keys()]);
  return { rec, inputs };
}
const stakersFrom = (inputs) => (v, prices, boundary, lb, days) => (inputs ? E.stakers(inputs, v, prices, boundary, lb, days) : new Map());
/** Audit + notice + digest of a record (the site's rendering; aline "" until PO-8). */
function evaluate(rec, inputs) {
  const lb = inputs ? E.lastBoundaryOf(inputs, rec.epoch) : 0;
  const audit = auditRecord(rec, { stakers: stakersFrom(inputs), lastBoundary: lb, now: num(rec.done) || null });
  return { audit, notice: auditNotice(rec.epoch, audit.problems), digest: digestOf(rec, "") };
}

const finalMemo = new Set();   // eids this process saw final (no query per 15 s pass)
const pendingSig = new Map();  // eid -> what the last pending write said
const lastEval = new Map();    // eid -> when (real s) a pending audit was last rebuilt
/**
 * SHADOW (via "shadow"): Pepe's settled epoch `eid` audited by the site and compared with his own notices. Starts once his push
 * says it is done and SHADOW_WAIT_S passed (real clock: his notices are pushed async); final once both of his rows were seen, or
 * SHADOW_FINAL_S after his done (a row still missing = he sent none); a pending row is rebuilt at most every SHADOW_EVERY_S.
 * Sends nothing. -> the row's state | null (not yet)
 */
async function shadowAudit(eid, realNowS = Date.now() / 1000) {
  if (finalMemo.has(eid)) return "final";
  await init();
  const have = await row(eid);
  if (have && have.state === "final") { finalMemo.add(eid); return "final"; }
  if (have && have.via === "site") return null;                     // the site ran this epoch itself (live): afterEpoch's
  const doneS = await pepeDone(eid);
  if (!doneS || realNowS < doneS + SHADOW_WAIT_S) return null;
  const late = realNowS >= doneS + SHADOW_FINAL_S;
  if (have && have.state === "pending" && !late && realNowS - (lastEval.has(eid) ? lastEval.get(eid) : -Infinity) < SHADOW_EVERY_S) return "pending";
  lastEval.set(eid, realNowS);
  const got = await pepeRecord(eid, doneS);
  const pepe = await pepeRows(eid);
  const seen = { audit_title: pepe.audit ? pepe.audit.title : null, audit_body: pepe.audit ? pepe.audit.body : null,
                 digest_title: pepe.digest ? pepe.digest.title : null, digest_body: pepe.digest ? pepe.digest.body : null, seen_at: Math.round(realNowS) };
  if (!got) {
    if (!late) return null;
    await putRow(eid, { via: "shadow", state: "final", audit: { problems: [], info: [], bind: {}, na: ["no shadow report of this epoch from Pepe (policy_sims)"] },
                        notice: null, digest: null, pepe: seen, audit_match: null, digest_match: null });
    finalMemo.add(eid);
    return "final";
  }
  const ev = evaluate(got.rec, got.inputs);
  ev.audit.na = ["conserved / pools_before / pools_after (Pepe's P3.1 sums are not pushed - info only, not in his notice)"];
  const final = (!!pepe.audit && !!pepe.digest) || late;
  // the audit notice: equal when both sent the same, or neither (only final: his may still come)
  const am = pepe.audit ? (ev.notice ? (matchAudit(eid, ev.audit.problems, pepe.audit) ? 1 : 0) : 0) : (ev.notice ? (late ? 0 : null) : (final ? 1 : null));
  const dm = pepe.digest ? (ev.digest ? (matchDigest((a) => digestOf(got.rec, a), pepe.digest.body) && storedTitle(ev.digest.title) === pepe.digest.title ? 1 : 0) : 0)
    : (ev.digest ? (late ? 0 : null) : (final ? 1 : null));
  // a pending row is rewritten only when something changed (his rows seen, a match, the site's audit) - not on every 15 s pass
  const sig = JSON.stringify([final, am, dm, !!pepe.audit, !!pepe.digest, ev.audit.problems, ev.digest && ev.digest.text]);
  if (!final && have && pendingSig.get(eid) === sig) return "pending";
  pendingSig.set(eid, sig);
  await putRow(eid, { via: "shadow", state: final ? "final" : "pending", audit: ev.audit, notice: ev.notice, digest: ev.digest, pepe: seen,
                      audit_match: am, digest_match: dm });
  if (final) {
    finalMemo.add(eid);
    console.log(`[policy] shadow audit ${eid}: audit ${am === 1 ? "= Pepe's" : "DIFFERS from Pepe's"}, digest ${dm === 1 ? "= Pepe's" : "DIFFERS from Pepe's"}`);
  }
  return final ? "final" : "pending";
}

/** The Pepe owners' accounts: pepe_roles "owner" -> users.camfrogUsername. */
async function ownerAccounts() {
  const { getQuery } = require("../dbUtils");
  const out = [];
  let owners = [];
  try { owners = Object.entries(await require("../staffroles").map()).filter(([, x]) => x.role === "owner").map(([l]) => l); } catch (e) { owners = []; }
  for (const l of owners) for (const u of await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [String(l).toLowerCase()]).catch(() => [])) out.push(u.userId);
  return [...new Set(out)];
}
/** Sends one notice (inbox to every owner account + opsalerts) under `ref`. */
async function sendNotice(ref, n) {
  const inbox = require("../inbox");
  for (const uid of await ownerAccounts()) await inbox.addSafe(uid, { kind: "admin", title: n.title, body: n.text, link: "/admin/economy", ref });
  try { await require("../opsalerts").alert({ source: "staking-digest", ref, title: n.title, body: n.text }); }
  catch (e) { console.error("[policy] staking digest ops alert:", e.message); }
}
/**
 * LIVE (dormant until the treasury engine is live): the audit and digest of the site's own settlement of `eid`, once its
 * transaction committed (`res` = runTreasuryEpoch's {plan, result, track}, or null: read from policy_runs - the scheduler's retry).
 * Never moves PAT, never throws. -> {audit, sent: {audit, digest}} | null
 */
async function afterEpoch(eid, res = null) {
  try {
    await init();
    const C = require("./core");
    const run = await C.run("treasury", eid);
    if (!run || run.state !== "done" || run.via !== "site") return null;
    const plan = (res && res.plan) || run.plan;
    if (!plan) return null;
    const r = (res && res.result) || run.result || {};
    let track = res && res.track !== undefined ? res.track : null;
    if (!track) { try { track = E.trackOf(run.inputs, plan); } catch (e) { track = null; } }
    const rec = Object.assign(JSON.parse(JSON.stringify(plan)), { state: "done", done_legs: r.done_legs || [], done: Number(plan.ts) || null,
                                                                 conserved: r.conserved, pools_before: r.pools_before, pools_after: r.pools_after },
                              track ? { track } : {});
    rec.notified = await notifiedOf(eid, [...stashPayouts(rec).keys()]);
    const ev = evaluate(rec, run.inputs);
    const have = await row(eid);
    if (!have) await putRow(eid, { via: "site", state: "final", audit: ev.audit, notice: ev.notice, digest: ev.digest, audit_match: null, digest_match: null });
    const cur = (await row(eid)) || {};
    const { runQuery } = require("../dbUtils");
    const sent = { audit: false, digest: false };
    // each notice once: recorded by the sent_at column AFTER it went out (review of PO-4: a crash between the two resends it on
    // the retry - harmless, the inbox keeps one row per (account, ref) and opsalerts files it under the same ref - where marking
    // it first would lose it for good); a second afterEpoch / the retry finds it set
    const mark = async (col) => {
      const u = await runQuery(`UPDATE policy_epoch_audit SET ${col} = ?, updated = ? WHERE eid = ? AND ${col} IS NULL`, [Date.now(), Date.now(), String(eid)]);
      return !!(u && u.changes);
    };
    const notice = cur.notice || ev.notice, digest = cur.digest || ev.digest;
    if (notice && !cur.audit_sent_at) { await sendNotice(`wf-audit:${eid}`, notice); sent.audit = await mark("audit_sent_at"); }
    if (digest && !cur.digest_sent_at) { await sendNotice(`wf-digest:${eid}`, digest); sent.digest = await mark("digest_sent_at"); }
    if (!notice && !cur.audit_sent_at) await mark("audit_sent_at");           // nothing to send: done with it
    if (!digest && !cur.digest_sent_at) await mark("digest_sent_at");
    if (sent.audit || sent.digest) console.log(`[policy] staking ${eid}: ${sent.audit ? "audit notice" : ""}${sent.audit && sent.digest ? " + " : ""}${sent.digest ? "digest" : ""} sent`);
    return { audit: ev.audit, sent };
  } catch (e) {
    console.error(`[policy] staking audit / digest ${eid}:`, e.message);
    return null;
  }
}
/** The live retry: a site-run weekly record (done in the last RETRY_DAYS) whose audit / digest isn't recorded as sent. */
async function retryLive() {
  const { getQuery } = require("../dbUtils");
  await init();
  const rows = await getQuery(`SELECT r.period AS eid FROM policy_runs r LEFT JOIN policy_epoch_audit a ON a.eid = r.period
                               WHERE r.engine = 'treasury' AND r.period LIKE 'W%' AND r.state = 'done' AND r.via = 'site' AND r.done >= ?
                                 AND (a.eid IS NULL OR a.audit_sent_at IS NULL OR a.digest_sent_at IS NULL) ORDER BY r.done`, [Date.now() - RETRY_DAYS * 86400e3]);
  for (const r of rows) await afterEpoch(r.eid);
  return rows.map((r) => r.eid);
}

/** Every audit row (newest first) for the admin view / preflight. */
async function recent(limit = 8) {
  await init();
  return (await require("../dbUtils").getQuery("SELECT eid, via, state, audit_match, digest_match, audit_sent_at, digest_sent_at, updated FROM policy_epoch_audit ORDER BY updated DESC LIMIT ?", [limit]));
}

module.exports = { auditRecord, auditNotice, digestOf, matchDigest, matchAudit, p31Base, stashPayouts, evaluate, pepeRecord, shadowAudit, afterEpoch, retryLive,
                   recent, row, init, storedBody, storedTitle, fixed, fmtG, cpLen, cpSlice, TR_WEEKLY_POOLS, TR_DAILY_POOLS, TR_VAULT_LABEL, SHADOW_WAIT_S,
                   SHADOW_FINAL_S, RETRY_DAYS, TEXT_MAX, get PEPE_LOGINS() { return PL.list(); }, isFinal: (eid) => finalMemo.has(eid), _forget: () => { finalMemo.clear(); pendingSig.clear(); lastEval.clear(); } };
