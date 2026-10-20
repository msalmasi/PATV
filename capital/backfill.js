// capital/backfill.js — the staking fix plan's one-time fixes (2026-10-19), run by tools/staking-backfill.js. Each is a DRY RUN
// unless apply; an apply takes a verified DB backup first, runs in ONE transaction, and records itself under capital_meta
// "backfill:<what>" - a second apply prints the stored result and changes nothing. None moves PAT.
//
//   cost     P0.3: d.cost[stash][vault] = {in, out} from the DONE requests still in the vault queue that the live path (since this
//            change) never counted. Requests leave the queue 30 days after they ran, so on prod it must run BEFORE 2026-11-04
//            (the first stakes ran on 2026-10-05). Each request is marked (costed) - never counted twice. Then every row is
//            re-checked (vaults.backfillCost): whole only while the queue still holds every request since the first cut-off
//            AND the stash's holding is explained by its requests; otherwise it stays partial (/staking: Staked / P/L "—").
//   earned   P0.2 (optional): stashes.earned += what staking paid the stash before payouts were counted as earned (stash moves
//            into the stash via "waterfall stakers", "staking correction ..." or the 1.99by "apr-bug correction"; a move whose
//            journal answer says it counted - earned in its result - is skipped). If Pepe (camfrog-bot d366b94+) ran BEFORE this
//            site version, the OLD site counted his payouts without marking the journal: then --before=<when that Pepe started>
//            is required (capital_meta "staking_fix", capital/service.noteFix, tells which came first).
//   cushion  P1.2 (optional): a vault's cushion from the skims the ceiling made BEFORE the cushion started recording, replayed
//            from the stored snapshots (vaults.replayCeiling) - only the last <days> days, only older than the oldest recorded
//            entry, and only for a vault whose replayed high-water mark equals the book's (else that vault is skipped).
"use strict";
const C = require("./core");
const V = require("./vaults");

const near = (d) => Math.abs(C.nowS() - Number(d.next_epoch || 0)) < 600;
const keyOk = (k) => /^[A-Za-z0-9_.:-]{3,60}$/.test(String(k || ""));
async function begin(what, { key, apply }) {
  await C.init();
  const done = await C.meta(`backfill:${what}`);
  if (done) return { already: true, done };
  if (!(await C.live())) throw new Error("the vault book doesn't live on this site (capital backend off) - nothing to do here");
  if (apply && !keyOk(key)) throw new Error("--apply needs --key=<a name for this run> (3-60 of A-Z a-z 0-9 _ . : -)");
  const d = await V.load();
  if (!d.inited) throw new Error("the vault book isn't initialised here");
  if (apply && near(d)) throw new Error("within 10 minutes of the daily cut-off - run it outside that window");
  return { already: false, backup: apply ? await require("../dbbackup").backupDb(`pre-staking-${what}`) : null };
}
async function finish(what, key, result, backup) {
  await C.setMeta(`backfill:${what}`, { key, at: Date.now(), result, backup });
}

/** P0.3 cost history. -> {already?, apply, items, stashes, in, out, per_stash, backup} */
async function cost({ key, apply = false } = {}) {
  const b = await begin("cost", { key, apply });
  if (b.already) return Object.assign({ already: true }, b.done);
  const run = async () => {
    const d = await V.load();
    const r = V.backfillCost(d);
    r.per_stash = Object.fromEntries(Object.entries(d.cost || {}).map(([s, x]) => [s, x]));
    if (apply) {
      await V.store(d);
      await finish("cost", key, { items: r.items, stashes: r.stashes, in: r.in, out: r.out, whole: r.whole, partial: r.partial.length }, b.backup);
    }
    return r;
  };
  const r = apply ? await C.tx(run) : await run();
  return Object.assign({ apply, backup: b.backup }, r);
}

/** Which went first, Pepe d366b94+ or this site version? -> {order: "site_first" | "pepe_first" | "unknown", fx} */
async function deployOrder() {
  const fx = await C.meta("staking_fix");
  if (!fx || fx.first_push === undefined || fx.first_push === null) return { order: "unknown", fx: fx || null };
  return { order: fx.first_push_new ? "pepe_first" : "site_first", fx };
}
/** P0.2 earned. before (ms, optional): only moves older than that - for a Pepe that passed earned before this site recorded it
 *  in the journal. Without it an apply needs the site to have gone first (deployOrder): Pepe's payouts through the old site
 *  were counted but not marked, and counting them again would double them.
 *  -> {apply, stashes: {id: PAT}, moves, total, skipped, order, warning?} */
async function earned({ key, apply = false, before = null } = {}) {
  await C.init();
  const ord = await deployOrder();
  let warning = null;
  if (before == null && ord.order !== "site_first") {
    warning = ord.order === "pepe_first"
      ? "Pepe with the staking fix was already running when this site version started: the old site counted his payouts in stashes.earned without marking them. Pass --before=<the time that Pepe started> (his deploy) so they aren't counted twice."
      : "This site hasn't seen a config push from Pepe yet, so it can't tell which was deployed first. Pass --before=<the time Pepe d366b94 started> (or wait for his push).";
    if (apply && !(await C.meta("backfill:earned"))) throw new Error(warning);     // before begin(): no backup taken for a refusal
  }
  const b = await begin("earned", { key, apply });
  if (b.already) return Object.assign({ already: true }, b.done);
  const { getQuery, runQuery } = require("../dbUtils");
  const run = async () => {
    const rows = (await getQuery(`SELECT key, stash_id, amount, via, result, ts FROM stash_moves WHERE amount > 0 AND ${V.PAID_VIA} ORDER BY ts`))
      .filter((r) => before == null || Number(r.ts) < Number(before));
    const per = {};
    let moves = 0, skipped = 0, total = 0;
    for (const r of rows) {
      let res = {};
      try { res = JSON.parse(r.result || "{}") || {}; } catch (e) { res = {}; }
      if (Number(res.earned) > 0) { skipped++; continue; }
      const id = String(r.stash_id);
      per[id] = (per[id] || 0) + Math.trunc(Number(r.amount) || 0);
      moves++; total += Math.trunc(Number(r.amount) || 0);
    }
    if (apply) {
      for (const [id, a] of Object.entries(per)) await runQuery("UPDATE stashes SET earned = earned + ?, updated = ? WHERE id = ?", [a, Date.now(), id]);
      await runQuery(`INSERT INTO stash_meta (key, value) VALUES ('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`);
      await finish("earned", key, { stashes: per, moves, total, skipped }, b.backup);
    }
    return { stashes: per, moves, total, skipped };
  };
  const r = apply ? await C.tx(run) : await run();
  return Object.assign({ apply, backup: b.backup, order: ord.order, before }, warning ? { warning } : {}, r);
}

/** P1.2 cushion seed. -> {apply, days, vaults: {v: {added: [[ts, shares]], pat, skipped?}}} */
async function cushion({ key, apply = false, days = null } = {}) {
  const b = await begin("cushion", { key, apply });
  if (b.already) return Object.assign({ already: true }, b.done);
  const run = async () => {
    const c = await C.cfg();
    const d = await V.load();
    // a snapshot that recorded its rule replays by it; one from before (no ceil_apr) by the 25% every cut-off ran with then -
    // pepe_stakingreplay's DEFAULT_CEIL, not today's setting (with the ceiling off that replayed them as off: no skims, and
    // the tracked high-water mark then never matched the book's, so every vault was skipped)
    const ceil = V.REPLAY_CEIL;
    const win = days == null ? V.cushionCfg(c).days : Math.max(0, Math.min(V.CUSHION_MAX_DAYS, Number(days)));
    const now = C.nowS();
    const rp = V.replayCeiling(d.epochs, ceil);
    const out = {};
    for (const v of V.VAULTS) {
      const st = d.v[v];
      if (!st) continue;
      const book = Number(st.peak_price), mine = rp.peak[v];
      if (!(book > 0) || !(mine > 0) || Math.abs(mine - book) > 1e-6 * book) {
        out[v] = { added: [], pat: 0, skipped: `the replayed high-water mark ${mine} isn't the book's ${book}` };
        continue;
      }
      const have = Array.isArray(st.cushion) ? st.cushion : [];
      const oldest = have.length ? Math.min(...have.map((e) => Number(e[0]))) : Infinity;
      const add = rp.skims.filter((s) => s.vault === v && s.ts >= now - win * 86400 - 600 && s.ts < oldest - 60 && s.shares > 1e-9);
      out[v] = { added: add.map((s) => [s.ts, s.shares]), pat: Math.trunc(add.reduce((a, s) => a + s.pat, 0)) };
      if (apply && add.length) st.cushion = add.map((s) => [s.ts, s.shares]).concat(have);
    }
    if (apply) { await V.store(d); await finish("cushion", key, { days: win, vaults: out }, b.backup); }
    return { days: win, ceil, vaults: out };
  };
  const r = apply ? await C.tx(run) : await run();
  return Object.assign({ apply, backup: b.backup }, r);
}

module.exports = { cost, earned, cushion, deployOrder };
