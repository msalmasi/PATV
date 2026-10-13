// policy/gscale.js — Q11 (ECONOMY-V3 23.2, approved by the user 2026-10-13): the ACTIVITY-SCALED guarantee target.
//
// The Monday incentive guarantee tops the incentive budget up to a target. With `guarantee_scaled` on (econ_cfg, OFF by
// default) that target follows the week's participation instead of the fixed incentive_guarantee_target:
//
//   target = clamp(guarantee_base x participants / reference, guarantee_min, guarantee_max), smoothed: the mean of the
//            last guarantee_smooth_weeks weekly targets (policy/engines.js gscale = pepe_monetary.gscale, the vectors)
//   participants  the distinct accounts credited a pad recipe payout (recipe_credits slices owner / streamers / people -
//                 every one of them already passed the recipe's anti-farm gates) in the epoch week (Monday 04:00 UTC)
//   reference     the median weekly count over the first guarantee_ref_weeks weeks of payouts (live 2026-10-12); until
//                 those weeks are complete the target stays at guarantee_base ("collecting")
//
// The series is the engines' `gweeks` input ([[week start, n], ...], complete weeks only, contiguous from the first week
// with a payout): policy/gather.js adds it while the switch is on, and Pepe reads the same list for his own engine
// (POST /api/policy/bot/gweeks {now}, cached by his policy worker) so the shadow diff stays zero.
//
// GET /api/admin/econ/gscale (Admin): this week's participants so far, last week's, the reference (or "collecting: N of
// 4 weeks"), the raw and smoothed target, the fixed target it replaces, the switch, and the DRY RUN - what the target
// was / WOULD be on every Monday since payouts began. The switch itself is `!econ set guarantee_scaled on|off`, sent
// through the /admin/economy econ edit (password step-up, Pepe validates; public/js/admin-gscale.js).
"use strict";
const E = require("./engines");

const SLICES = ["owner", "streamers", "people"];          // the gang slice is not a pad participant
const START_S = Date.UTC(2026, 9, 12, 4) / 1000;           // pad recipe payouts went live (Monday 2026-10-12 04:00 UTC)
const WEEK = E.WEEK;
const MAX_WEEKS = 520;

/** Monday 1970-01-05 at the epoch hour: every epoch week starts a whole number of weeks after it. */
const anchorOf = (hour) => 4 * 86400 + Math.trunc(hour) * 3600;

/** [[week start, distinct gated payout participants], ...]: the complete epoch weeks before the boundary of `nowS`,
 *  contiguous (a week without payouts is 0) from the first week with one. */
async function weeks(nowS, hour = 4) {
  const { getQuery } = require("../dbUtils");
  await require("../recipe").init();
  const M = E.weekStart(nowS, hour);
  const A = anchorOf(hour);
  const rows = await getQuery(`SELECT ((created / 1000 - ?) / ${WEEK}) AS wk, COUNT(DISTINCT userId) AS n FROM recipe_credits
                               WHERE slice IN (${SLICES.map(() => "?").join(",")}) AND created >= ? AND created < ? GROUP BY wk ORDER BY wk`,
                              [A, ...SLICES, START_S * 1000, M * 1000]);
  if (!rows.length) return [];
  const by = new Map(rows.map((r) => [Math.trunc(Number(r.wk)), Math.trunc(Number(r.n) || 0)]));
  const first = Math.min(...by.keys());
  const last = Math.trunc((M - A) / WEEK) - 1;
  const out = [];
  for (let wk = Math.max(first, last - MAX_WEEKS + 1); wk <= last; wk++) out.push([A + wk * WEEK, by.get(wk) || 0]);
  return out;
}

/** Distinct gated payout participants so far in the running week. */
async function running(nowS, hour = 4) {
  const { getQuery } = require("../dbUtils");
  await require("../recipe").init();
  const M = E.weekStart(nowS, hour);
  const r = await getQuery(`SELECT COUNT(DISTINCT userId) AS n FROM recipe_credits WHERE slice IN (${SLICES.map(() => "?").join(",")}) AND created >= ?`,
                           [...SLICES, Math.max(M, START_S) * 1000]);
  return Math.trunc(Number((r[0] || {}).n) || 0);
}

const hourOf = (consts) => {
  const h = Number((consts || {}).VAULT_EPOCH_UTC_HOUR);
  return Number.isFinite(h) ? Math.trunc(h) : E.CONSTS.VAULT_EPOCH_UTC_HOUR;
};

/** The admin card: the live numbers and the per-Monday dry run. */
async function view(nowS) {
  const G = require("./gather");
  const { cfg, consts } = await G.config();
  const c = Object.assign({}, E.DEFAULTS, cfg);
  const hour = hourOf(consts);
  const M = E.weekStart(nowS, hour);
  const ws = await weeks(nowS, hour);
  const get = (k) => c[k];
  const g = E.gscale(ws, M, get);
  const fixed = E.guaranteeBase(E.C({ cfg: c, consts }));
  const history = [];
  if (ws.length) {
    for (let m = Math.max(ws[0][0] + WEEK, M - 51 * WEEK); m <= M; m += WEEK) {
      const x = E.gscale(ws, m, get);
      history.push({ monday: m, week: E.epochId(m, hour), participants: x.participants, collecting: x.collecting, reference: x.reference,
                     raw: x.raw, target: x.target });
    }
  }
  return {
    on: !!c.guarantee_scaled, guarantee_on: !!c.incentive_guarantee, epoch: E.epochId(nowS, hour), monday: M,
    settings: { base: g.base, min: g.min, max: g.max, smooth_weeks: g.smooth_weeks, ref_weeks: g.ref_weeks },
    this_week: { participants: await running(nowS, hour), start: M },
    last_week: { participants: g.participants, start: M - WEEK },
    weeks_have: g.weeks_have, collecting: g.collecting, reference: g.reference, raw: g.raw, raws: g.raws, target: g.target,
    fixed_target: fixed, in_force: c.guarantee_scaled ? g.target : fixed, issuance_to_guarantee: !!c.issuance_to_guarantee,
    weeks: ws.slice(-26), history: history.reverse(), start: START_S,
  };
}

function register(app, { isBotToken, addUser }) {
  // Pepe's copy of the series (his engine plans from the same list): {now} -> the complete weeks before that epoch
  app.post("/api/policy/bot/gweeks", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const nowS = Number.isFinite(Number(b.now)) && Number(b.now) > 0 ? Number(b.now) : Date.now() / 1000;
      const { consts } = await require("./gather").config();
      res.json({ ok: true, weeks: await weeks(nowS, hourOf(consts)) });
    } catch (e) {
      console.error("[gscale] bot:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });
  app.get("/api/admin/econ/gscale", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ error: "Sign in first." });
    if (req.user.class !== "Admin") return res.status(403).json({ error: "Admins only." });
    try {
      res.json(Object.assign({ ok: true }, await view(require("./core").nowS())));
    } catch (e) {
      console.error("[gscale] view:", e);
      res.status(500).json({ error: "failed" });
    }
  });
}

module.exports = { weeks, running, view, register, SLICES, START_S, anchorOf };
