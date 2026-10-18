// capital/service.js — Phase 3: the routes, the tick, the cutover and the way back for the capital cluster
// (capital/markets.js, capital/reserve.js, capital/vaults.js; the store is capital/core.js). docs/capital-cutover-runbook.md.
//
// Bot routes (bot token, POST - the staging router falls back to Pepe's sandbox, which answers 503: never a local copy):
//   /api/capital/bot/state      {since_rev?}             -> {ok, enabled, live, rev, markets, loans, requests, vaults, ...} (Pepe's mirror)
//   /api/capital/bot/op         {engine, verb, actor, args, idem}   one keyed action (a read verb is answered without a key)
//   /api/capital/bot/op-status  {key}                    -> the recorded answer, or null (a lost answer is looked up here)
//   /api/capital/bot/config     {cfg}                    Pepe's constants + the policy state he still owns (Phase 4)
//   /api/capital/admin/import   {key, payload, digest, totals, actor}   the cutover (32 MB body, skipped by index.js' 100 KB parser)
//   /api/capital/admin/export   {}                       read only: everything in Pepe's shapes + sha256 + totals
//   /api/capital/admin/rollback {key, actor}             the way back while the site answers (keyed)
// Events: the escrow event stream, game "capital" (POST /api/escrow/bot/poll {games: ["capital"]}).
// Web: /markets/:id/bet|sell|resolve (markets.js), /act cmd=loan reserve|request|repay|... and cmd=stash stake|unstake (actions.js).
// Admin: GET /api/admin/capital, POST /api/admin/capital-backend {on}.
"use strict";
const crypto = require("crypto");
const C = require("./core");
const M = require("./markets");
const R = require("./reserve");
const V = require("./vaults");
const X = require("./lmsr");

const ENGINES = { markets: M, reserve: R, vaults: V };
const IDEM_RE = /^[A-Za-z0-9_.:@\-]{6,120}$/;
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const backupDb = (tag) => require("../dbbackup").backupDb(tag);
let supplyFn = null;

// ── one action ──
class Rolled extends Error { constructor(res) { super(res.error || res.code || "refused"); this.res = res; } }
/** One keyed action in ONE transaction (a refusal rolls back everything it wrote). -> the engine's answer. */
async function act(engine, body) {
  await C.init();
  const E = ENGINES[engine];
  if (!E) return { ok: false, code: "no_engine", error: "no such engine" };
  if (!(await C.live())) return { ok: false, code: "not_live", error: "the markets, Reserve loans and vaults still live in Pepe" };
  const verb = String(body.verb || "").toLowerCase();
  const actor = Object.assign({}, body.actor || {});
  actor.via = String(actor.via || "room").slice(0, 12);
  const args = body.args || {};
  if (E.READS.includes(verb)) return Object.assign({ ok: true }, await E.read(verb, actor, args));
  const idem = body.idem ? String(body.idem) : null;
  if (idem && !IDEM_RE.test(idem)) return { ok: false, code: "bad_request", error: "bad idem" };
  const key = `${engine}:${idem || "u-" + crypto.randomBytes(9).toString("hex")}`;
  let out;
  try {
    out = await C.tx(async () => {
      const dup = await C.seen(key);
      if (dup) return dup;
      const res = await E.act(verb, actor, args, { nowS: C.nowS(), key });
      if (!res || !res.ok) throw new Rolled(res || { ok: false, code: "failed" });
      await C.record(key, `${engine}:${verb}`, res.ref, actor.via, res);
      res.rev = await C.bumpRev();
      return res;
    });
  } catch (e) {
    if (e instanceof Rolled) return e.res;
    if (C.isRefuse(e)) return { ok: false, code: refuseCode(e.code), error: e.message, extra: e.extra || undefined };
    throw e;
  }
  C.wake();
  if (!out.dup) publishSoon();
  return out;
}
function refuseCode(c) {
  return ({ E_INSUFFICIENT_PAT: "insufficient", E_TARGET_NOT_FOUND: "no_account", E_INSUFFICIENT: "pool_short", E_STASH: "stash_short" })[c]
    || String(c || "failed").toLowerCase();
}

// ── the display snapshots (the pages read them): debounced, never part of a PAT transaction ──
let pubTimer = null;
function publishSoon(ms = 1500) {
  if (pubTimer) return;
  pubTimer = setTimeout(() => { pubTimer = null; publishAll().catch((e) => console.error("[capital] publish:", e.message)); }, ms);
  if (pubTimer.unref) pubTimer.unref();
}
async function publishAll() {
  if (!(await C.live())) return;
  await R.publish();
  await V.publish();
}

// ── the tick (15 s): deadlines, collection, defaults, the 04:00 UTC cut-off, pruning ──
let ticking = false, lastPrune = 0, lastPub = 0;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!(await C.live())) return;
    const imp = await C.meta("imported");
    if (imp && !imp.rolled_back && Date.now() - Number(imp.at || 0) < 120000) return;     // the cutover's own verification window
    const run = async (what, fn) => {
      try {
        const r = await C.tx(async () => {
          const x = await fn({ nowS: C.nowS(), key: `tick-${what}-${Date.now()}` });
          if (x && x.ok) await C.bumpRev();
          return x;
        });
        if (r && r.ok) { C.wake(); publishSoon(); }
        return r;
      } catch (e) { console.error(`[capital] ${what}:`, e.message); return null; }
    };
    for (const id of (await M.due(C.nowS())).slice(0, 50)) await run(`market-${id}`, (t) => M.expire(id, t));
    for (const id of (await R.due(C.nowS())).slice(0, 50)) await run(`collect-${id}`, (t) => R.collect(id, t));
    for (const x of (await R.defaults({ nowS: C.nowS() })).slice(0, 20)) await run(`default-${x.id}`, (t) => R.defaultOne(x.id, t));
    const d = await V.load();
    if (d.inited && Number((await C.cfg()).vaults_enabled) && C.nowS() >= Number(d.next_epoch || 0)) {
      const r = await run("epoch", async (t) => {
        const e = await V.epoch(t);
        await C.emit("vault_epoch", null, { snap: e.snap, notes: e.notes });
        return Object.assign({ ok: true }, e);
      });
      if (r) console.log(`[capital] cut-off: prices ${JSON.stringify(r.snap.price)} nav ${JSON.stringify(r.snap.nav)} queue ${JSON.stringify(r.notes.queue)}`);
    }
    if (Date.now() - lastPrune > 6 * 3600000) {
      lastPrune = Date.now();
      await run("prune", async (t) => ({ ok: (await R.prune(t)) > 0 }));
    }
    if (Date.now() - lastPub > 300000) { lastPub = Date.now(); publishSoon(10); }
  } finally { ticking = false; }
}

// ── Pepe's constants + his policy state ──
const CFG_NUM = ["min_trade", "settle_grace", "max_secs", "max_open", "loan_min", "rloan_enabled", "rloan_rate_week", "rloan_base", "rloan_per_level",
                 "rloan_max_auto", "rloan_max_days", "rloan_book_share", "rloan_max_open", "penalty_pct", "penalty_cap_pct", "collect_every",
                 "loan_max_borrowed", "vaults_enabled", "ceil_apr", "floor_apr", "topup", "topup_max_day", "staker_max", "house_min_cash",
                 "auto_bank_min", "auto_house_max", "auto_mm_max", "bank_default_days", "bank_insurance_cap", "min_move", "epoch_hour", "dividend",
                 "apr_min_cover", "fl_room", "lotto_pot"];
async function putConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const out = { at: C.nowS() };
  for (const k of CFG_NUM) if (c[k] !== undefined && Number.isFinite(Number(c[k]))) out[k] = Number(c[k]);
  for (const k of ["layers", "tr_live"]) if (c[k] !== undefined) out[k] = !!c[k];
  if (c.targets && typeof c.targets === "object") out.targets = Object.fromEntries(V.VAULTS.filter((v) => Number.isFinite(Number(c.targets[v]))).map((v) => [v, Number(c.targets[v])]));
  if (c.flash && typeof c.flash === "object") out.flash = { bank: !!c.flash.bank, mm: !!c.flash.mm, room: Math.max(0, Math.trunc(Number(c.flash.room) || 0)) };
  if (c.credit && typeof c.credit === "object") out.credit = require("../credit").cleanWeights(c.credit);
  for (const k of ["flows", "heist_log", "heist_settings"]) {
    if (c[k] !== undefined) { const s = JSON.stringify(c[k]); if (s.length < 200000) out[k] = c[k]; }
  }
  const prev = (await C.meta("cfg")) || {};
  await C.setMeta("cfg", Object.assign({}, prev, out));
  return { ok: true, at: out.at };
}

// ── the cutover ──
/** The canonical facts both sides hash: no floats as text (each float as its 64-bit pattern), sorted, PAT first. */
function fbits(x) {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, Number(x));
  return b.getBigInt64(0).toString();
}
function factsOf(st) {
  const ms = (st.markets || []).filter((m) => ["open", "closed", "settling"].includes(m.status)).slice().sort((a, b) => a.id - b.id)
    .map((m) => [m.id, m.status, Math.trunc(Number(m.pool) || 0), m.options.map((o) => fbits((m.q || {})[o] || 0)),
                 Object.keys(m.positions || {}).sort().map((k) => [k, Object.keys(m.positions[k].shares || {}).sort().map((o) => [o, fbits(m.positions[k].shares[o])])])]);
  const ls = (st.loans || []).slice().sort((a, b) => a.id - b.id).map((l) => [l.id, l.status, Math.trunc(l.principal), Math.trunc(l.paid || 0), Math.trunc(l.owed), l.funded_by || null]);
  const rq = (st.requests || []).slice().sort((a, b) => a.id - b.id).map((r) => [r.id, r.status, Math.trunc(r.amount)]);
  const d = st.vaults || {};
  const sh = {};
  for (const v of V.VAULTS) {
    const x = (d.v || {})[v] || {};
    sh[v] = [fbits(x.total || 0), Object.keys(x.holders || {}).sort().map((k) => [k, fbits(x.holders[k])])];
  }
  const au = d.auto || {};
  sh.auto = [fbits(au.total || 0), Object.keys(au.holders || {}).sort().map((k) => [k, fbits(au.holders[k])])];
  const q = Object.keys(d.queue || {}).sort().filter((k) => ["pending", "moving"].includes(d.queue[k].state))
    .map((k) => [k, d.queue[k].state, d.queue[k].kind, d.queue[k].vault, d.queue[k].amount == null ? null : Math.trunc(d.queue[k].amount),
                 d.queue[k].shares == null ? null : fbits(d.queue[k].shares)]);
  return { markets: ms, loans: ls, requests: rq, shares: sh, queue: q };
}
const digestOf = (st) => sha(JSON.stringify(factsOf(st)));
function totalsOf(st) {
  const live = (st.markets || []).filter((m) => ["open", "closed", "settling"].includes(m.status));
  const d = st.vaults || {};
  const open = (st.loans || []).filter((l) => R.OPEN.includes(l.status));
  return {
    markets: live.length, pots: live.reduce((s, m) => s + Math.trunc(Math.max(0, Number(m.pool) || 0)), 0),
    loans: (st.loans || []).length, loans_open: open.length,
    loans_out: open.filter((l) => l.funded_by === "bank" && !l.insured && !l.written_off).reduce((s, l) => s + Math.max(0, Math.trunc(l.principal) - Math.trunc(l.paid || 0)), 0),
    owed_left: open.reduce((s, l) => s + Math.max(0, Math.trunc(l.owed) - Math.trunc(l.paid || 0)), 0),
    requests_pending: (st.requests || []).filter((r) => r.status === "pending").length,
    queue_held: Object.values(d.queue || {}).filter((q) => q.state === "pending" && q.kind === "deposit" && q.held).reduce((s, q) => s + Math.trunc(q.amount), 0),
    queue: Object.values(d.queue || {}).filter((q) => ["pending", "moving"].includes(q.state)).length,
  };
}

/** Pepe's record -> the site's (positions' key order and each holder's cost / shares order carried in _ord from his export). */
function cleanMarket(m, order) {
  if (!m || typeof m !== "object" || m.model !== "lmsr") throw new C.Refuse(400, `not an LMSR market: ${JSON.stringify(m && m.id)}`, "E_PAYLOAD");
  const id = Math.trunc(Number(m.id));
  if (!(id > 0) || !Array.isArray(m.options) || m.options.length < 2) throw new C.Refuse(400, `market ${m.id}: bad id / options`, "E_PAYLOAD");
  if (m.status === "settling") throw new C.Refuse(409, `M${id} is settling - let it finish`, "E_PENDING");
  const pool = Number(m.pool);
  if (["open", "closed"].includes(m.status) && (!Number.isFinite(pool) || pool < 0 || pool !== Math.trunc(pool))) throw new C.Refuse(400, `M${id}: bad pot ${m.pool}`, "E_PAYLOAD");
  const o = order || {};
  m._ord = { pos: Array.isArray(o.pos) ? o.pos.map(String) : Object.keys(m.positions || {}), cost: o.cost || {}, shares: o.shares || {} };
  return m;
}
async function stateAll({ recentDays = 60 } = {}) {
  const cut = C.nowS() - recentDays * 86400;
  const markets = (await C.list("market")).filter((m) => ["open", "closed", "settling"].includes(m.status) || Number(m.ended || m.created || 0) >= cut);
  return { markets, loans: await C.list("loan"), requests: await C.list("request"), credit: await C.doc("credit", {}), vaults: await V.load() };
}

async function importFromPepe(body) {
  await C.init();
  if (!(await C.enabled())) throw new C.Refuse(409, "the capital backend is switched off on this site", "E_FEATURE_OFF");
  const key = C.checkKey(body && body.key);
  const payload = String((body && body.payload) || "");
  const digest = sha(payload);
  if (!payload || digest !== String(body.digest || "")) throw new C.Refuse(400, "digest mismatch", "E_DIGEST");
  const done = await C.meta("imported");
  if (done && done.key === key && !done.rolled_back) {
    if (done.digest === digest) return Object.assign({ ok: true, already: true }, done.answer || {});
    throw new C.Refuse(409, "this cutover key was already used with a different export", "E_ALREADY");
  }
  if (await C.live()) throw new C.Refuse(409, "the site already owns the capital cluster (another import)", "E_ALREADY");
  if (!(await require("../pools").live())) throw new C.Refuse(409, "the pools still live in Pepe - Phase 3 comes after the pools cutover", "E_POOLS_LOCAL");
  if (!(await require("../stashes").live())) throw new C.Refuse(409, "the stashes still live in Pepe - they move first", "E_STASHES_LOCAL");
  let x;
  try { x = JSON.parse(payload); } catch (e) { throw new C.Refuse(400, "payload is not JSON", "E_PAYLOAD"); }
  if (!x || typeof x !== "object" || !x.markets || !x.loans || !x.vaults) throw new C.Refuse(400, "payload has no markets / loans / vaults", "E_PAYLOAD");
  const markets = (x.markets.records || []).map((m) => cleanMarket(m, (x.markets.order || {})[String(m.id)]));
  const loans = (x.loans.loans || []).filter((l) => l && l.reserve);
  for (const l of loans) {
    if (l.status === "funding") throw new C.Refuse(409, `L${l.id} is still being funded - let it finish`, "E_PENDING");
    if (!Number.isSafeInteger(Number(l.principal)) || !Number.isSafeInteger(Number(l.owed))) throw new C.Refuse(400, `L${l.id}: bad amounts`, "E_PAYLOAD");
  }
  const requests = (x.loans.requests || []).filter(Boolean);
  if (requests.some((r) => r.status === "approving")) throw new C.Refuse(409, "a Reserve loan request is being approved - let it finish", "E_PENDING");
  const vdoc = {};
  for (const k of V.SITE_KEYS) if (x.vaults[k] !== undefined) vdoc[k] = x.vaults[k];
  for (const q of Object.values(vdoc.queue || {})) {
    if (q.state === "moving") throw new C.Refuse(409, `vault request ${q.id} is mid-move - let it finish`, "E_PENDING");
    if (q.state === "pending" && q.kind === "deposit" && !q.held) throw new C.Refuse(409, `vault request ${q.id} isn't held yet`, "E_PENDING");
  }
  const st0 = { markets, loans, requests, vaults: vdoc };
  const mine = totalsOf(st0);
  const tt = (body && body.totals) || {};
  for (const k of ["markets", "pots", "loans", "loans_open", "loans_out", "owed_left", "requests_pending", "queue_held", "queue"]) {
    if (Math.trunc(Number(tt[k])) !== mine[k]) throw new C.Refuse(400, `totals don't match: ${k} ${mine[k]} in the export vs ${tt[k]}`, "E_TOTALS");
  }
  if (String(tt.digest || "") !== digestOf(st0)) throw new C.Refuse(400, "the record digest doesn't match the export's", "E_DIGEST");
  // every holder, borrower and requester has an account here
  const missing = [];
  const users = x.users && typeof x.users === "object" ? x.users : {};
  for (const m of markets) {
    for (const p of Object.values(m.positions || {})) {
      if (!(await C.account({ username: p.user, login: p.nick }))) missing.push(`M${m.id}:${p.nick}`);
    }
  }
  for (const l of loans.filter((l) => R.OPEN.includes(l.status))) {
    const a = await C.account({ userId: (l.uids || {}).borrower, login: l.borrower });
    if (!a) missing.push(`L${l.id}:${l.borrower}`);
    else l.uids = Object.assign({}, l.uids || {}, { borrower: a.userId }), l.users = Object.assign({}, l.users || {}, { borrower: a.username });
  }
  for (const r of requests) {
    const a = await C.account({ userId: (users[C.low(r.nick)] || {}).userId, login: r.nick });
    if (a) r.uid = a.userId;
    else if (r.status === "pending") missing.push(`LR${r.id}:${r.nick}`);
  }
  if (missing.length) throw new C.Refuse(409, `${missing.length} account(s) don't exist here (${missing.slice(0, 5).join(", ")})`, "E_IDENTITY");
  // the M numbering is shared with the site's betting pools: an imported market's id must not be a site pool's
  const clash = [];
  for (const m of markets) {
    const r = (await require("../dbUtils").getQuery("SELECT 1 FROM escrow_games WHERE game = 'pools' AND id = ?", [m.id]).catch(() => []))[0];
    if (r) clash.push(`M${m.id}`);
  }
  if (clash.length) throw new C.Refuse(409, `market id(s) ${clash.slice(0, 8).join(", ")} belong to the site's betting pools`, "E_ID_CLASH");
  const potRows = await require("../dbUtils").getQuery("SELECT key, balance FROM pools WHERE key LIKE 'market:%' AND balance != 0");
  if (potRows.length) throw new C.Refuse(409, `market pots already hold PAT here (${potRows.slice(0, 3).map((r) => r.key + "=" + r.balance).join(", ")})`, "E_NOT_EMPTY");
  const vf = await require("../pools").balance("vaultfloat");
  if (vf < mine.queue_held) throw new C.Refuse(409, `vaultfloat holds ${vf}, the queued stakes ${mine.queue_held}`, "E_VAULTFLOAT");
  const nv = x.navs || {};
  const backup = await backupDb("pre-capital-import");
  let answer;
  try {
    answer = await C.tx(async () => {
      if (await C.meta("live")) throw new C.Refuse(409, "already imported", "E_ALREADY");
      const { runQuery, getQuery } = require("../dbUtils");
      await runQuery("DELETE FROM capital_records");
      await runQuery("DELETE FROM capital_docs");
      await runQuery("DELETE FROM pools WHERE key LIKE 'market:%' AND balance = 0");
      let before = null;
      if (supplyFn) {
        if (Number.isSafeInteger(Number(x.supply_markets))) {
          const snap = (await getQuery("SELECT pools FROM supply_snapshot WHERE id = 1"))[0];
          const rows = C.parse(snap && snap.pools, []).filter((r) => String(r.key) !== "markets");
          if (Number(x.supply_markets) > 0) rows.push({ key: "markets", label: "🔮 Prediction-market pots", amount: Number(x.supply_markets) });
          await runQuery("INSERT INTO supply_snapshot (id, pools, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET pools = excluded.pools, updated_at = CURRENT_TIMESTAMP",
                         [JSON.stringify(rows)]);
        }
        before = (await supplyFn()).total;
      }
      const t = Date.now();
      const legs = [];
      const c0 = Object.assign({}, x.cfg || {});
      if (Object.keys(c0).length) await putConfig(c0);
      for (const m of markets) {
        await M.put(m);
        const pot = ["open", "closed"].includes(m.status) ? Math.trunc(Number(m.pool) || 0) : 0;
        if (pot) {
          await runQuery("INSERT INTO pools (key, label, balance, updated) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET label = excluded.label, balance = excluded.balance, updated = excluded.updated",
                         [M.potKey(m.id), `🔮 M${m.id} pot`, pot, t]);
          legs.push({ pool: M.potKey(m.id), amount: pot });
        }
      }
      for (const l of loans) await C.save("loan", l, l.status === "active" ? l.due : null);
      for (const r of requests) await C.save("request", r);
      const ar = {};
      for (const [k, h] of Object.entries(x.loans.credit || {})) {
        const a = await C.account({ login: k });
        const kk = a ? `u:${a.userId}` : `l:${C.low(k)}`;
        const prev = ar[kk] || { h: {}, login: C.low(k) };
        for (const [f, n] of Object.entries(h || {})) prev.h[f] = Math.trunc(Number(prev.h[f] || 0) + Number(n || 0));
        prev.keys = (prev.keys || []).concat([k]);
        ar[kk] = prev;
      }
      await C.putDoc("credit", ar);
      await V.store(vdoc);
      for (const [k, v] of [["seq:market", x.markets.seq], ["seq:loan", x.loans.seq], ["seq:request", x.loans.rseq]]) {
        const n = Math.max(Math.trunc(Number(v) || 0), Math.trunc(Number(await C.meta(k)) || 0));
        await C.setMeta(k, n);
      }
      const L = require("../escrow/ledger");
      for (const [g, k] of [["pools", "seq:market"], ["loans", "seq:loan"]]) {
        const n = Math.max(Math.trunc(Number(await C.meta(k)) || 0), Math.trunc(Number(await L.meta(`seq:${g}`)) || 0));
        await L.setMeta(`seq:${g}`, n);
        await C.setMeta(k, n);
      }
      const mk = "import:capital:" + key;
      for (let i = 0; i < legs.length; i++) {
        await runQuery("INSERT INTO pool_move_legs (move_key, i, pool, amount, after, ts) VALUES (?, ?, ?, ?, ?, ?)", [mk, i, legs[i].pool, legs[i].amount, legs[i].amount, t]);
      }
      await C.setMeta("live", true);
      C.forgetLive();
      // verify: the records as written, the pots, the NAV components and the share book
      const st = await stateAll({ recentDays: 3650 });
      const got = totalsOf(st);
      for (const k of Object.keys(mine)) if (got[k] !== mine[k]) throw new C.Refuse(500, `${k} reads ${got[k]} after the import, not ${mine[k]}`, "E_VERIFY");
      const potSum = Number((await getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM pools WHERE key LIKE 'market:%'"))[0].t) || 0;
      if (potSum !== mine.pots) throw new C.Refuse(500, `the market pots hold ${potSum}, not ${mine.pots}`, "E_VERIFY");
      const dg = digestOf(st);
      if (dg !== tt.digest) throw new C.Refuse(500, "the records read back differently (digest)", "E_VERIFY");
      const k = await V.ctx();
      const d = await V.load();
      const p = V.prices(d, k);
      const site = { cash: k.cash, loans_out: k.loans_out, mm_book: k.mm_book, nav: Object.fromEntries(V.VAULTS.map((v) => [v, V.nav(v, k)])), prices: p };
      const navCheck = {};
      for (const v of V.VAULTS) {
        const pepeNav = Number((nv.nav || {})[v]);
        navCheck[v] = { pepe: pepeNav, site: site.nav[v], match: pepeNav === site.nav[v], pat: Math.trunc(pepeNav) === Math.trunc(site.nav[v]),
                        price_pepe: Number((nv.prices || {})[v]), price_site: p[v], price_match: Number((nv.prices || {})[v]) === p[v] };
      }
      navCheck.auto = { price_pepe: Number((nv.prices || {}).auto), price_site: p.auto, price_match: Number((nv.prices || {}).auto) === p.auto };
      const comp = { loans_out: site.loans_out === Number(nv.loans_out), mm_book: site.mm_book.value === Number((nv.mm_book || {}).value)
                       && site.mm_book.seeds === Number((nv.mm_book || {}).seeds),
                     cash: ["bank", "mm", "jackpot"].every((c) => site.cash[c] === Number((nv.cash || {})[c])) };
      if (!comp.loans_out || !comp.mm_book) throw new C.Refuse(500, `the NAV components differ: ${JSON.stringify({ site: { loans_out: site.loans_out, mm_book: site.mm_book }, pepe: { loans_out: nv.loans_out, mm_book: nv.mm_book } })}`, "E_NAV");
      if (!comp.cash) throw new C.Refuse(409, `vault cash moved during the cutover (Pepe read ${JSON.stringify(nv.cash)}, the site has ${JSON.stringify(site.cash)}) - run it again`, "E_NAV_CASH");
      for (const v of V.VAULTS) if (!navCheck[v].pat) throw new C.Refuse(500, `${v} NAV ${navCheck[v].site} here vs ${navCheck[v].pepe} on Pepe`, "E_NAV");
      let after = null;
      if (before !== null) {
        after = (await supplyFn()).total;
        if (after !== before) throw new C.Refuse(500, `the supply total moved: ${before} before, ${after} after`, "E_SUPPLY");
      }
      const out = { totals: got, expected: mine, digest: dg, nav: navCheck, components: comp, pots: potSum, supply_before: before, supply_after: after, backup };
      await require("../pools")._recordMove(mk, { kind: "import", flow: "capital-cutover", why: "market pots moved from Pepe", via: "pepe", legs, net: mine.pots, ts: t,
                                                   result: { ok: true, totals: got, digest: dg } });
      await C.setMeta("imported", { key, digest, at: t, answer: out, actor: C.str(body.actor, 40) });
      await C.bumpRev();
      return out;
    });
  } catch (e) {
    C.forgetLive();
    if (C.isRefuse(e)) { e.message += " - rolled back, nothing kept"; throw e; }
    throw e;
  }
  C.forgetLive();
  publishSoon(10);
  console.log(`[capital] imported ${mine.markets} market(s) (${mine.pots} PAT in pots), ${mine.loans} Reserve loan(s), the vault book (${mine.queue} queued) from Pepe (key ${key}, backup ${backup})`);
  return Object.assign({ ok: true }, answer);
}

async function exportState() {
  await C.init();
  const st = await stateAll();
  let navs = null;
  if (await C.live()) {
    const k = await V.ctx();
    const p = V.prices(st.vaults, k);
    navs = { cash: k.cash, loans_out: k.loans_out, mm_book: k.mm_book, nav: Object.fromEntries(V.VAULTS.map((v) => [v, V.nav(v, k)])), prices: p };
  }
  return Object.assign({ ok: true, live: await C.live(), enabled: await C.enabled(), rev: await C.rev(), imported: await C.meta("imported"),
                         totals: totalsOf(st), digest: digestOf(st), navs, cfg: await C.cfg() }, st);
}

/** The way back while the site answers: the market pots go back to Pepe under one key, live off; the answer is everything. */
async function rollbackToPepe({ key, actor }) {
  await C.init();
  key = C.checkKey(key);
  const mk = "rollback:capital:" + key;
  const prev = await require("../pools").moveStatus(mk);
  if (prev) return Object.assign({}, prev, { dup: true });
  if (!(await C.live())) throw new C.Refuse(409, "the capital cluster isn't live here", "E_NOT_LIVE");
  const backup = await backupDb("pre-capital-rollback");
  const out = await C.tx(async () => {
    const { runQuery, getQuery } = require("../dbUtils");
    const st = await stateAll();
    if (st.markets.some((m) => m.status === "settling")) throw new C.Refuse(409, "a market is settling - try again in a moment", "E_PENDING");
    if (Object.values(st.vaults.queue || {}).some((q) => q.state === "moving")) throw new C.Refuse(409, "a vault request is mid-move", "E_PENDING");
    const pots = await getQuery("SELECT key, balance FROM pools WHERE key LIKE 'market:%' AND balance > 0 ORDER BY key");
    const legs = pots.map((r) => ({ pool: r.key, amount: -Number(r.balance) }));
    const sum = pots.reduce((s, r) => s + Number(r.balance), 0);
    let before = null;
    if (supplyFn) before = (await supplyFn()).total;
    const a = legs.length ? await require("../pools")._applyLegs(mk, legs, { kind: "rollback", flow: "rollback", why: "market pots back to Pepe", via: "pepe" }) : { net: 0, ts: Date.now() };
    const left = Number((await getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM pools WHERE key LIKE 'market:%'"))[0].t) || 0;
    if (left) throw new C.Refuse(500, `the market pots still hold ${left}`, "E_VERIFY");
    // Pepe holds the pots again: his supply row comes back in the same transaction (the total doesn't move)
    const snap = (await getQuery("SELECT pools FROM supply_snapshot WHERE id = 1"))[0];
    const rows = C.parse(snap && snap.pools, []).filter((r) => String(r.key) !== "markets");
    if (sum > 0) rows.push({ key: "markets", label: "🔮 Prediction-market pots", amount: sum });
    await runQuery("INSERT INTO supply_snapshot (id, pools, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET pools = excluded.pools, updated_at = CURRENT_TIMESTAMP",
                   [JSON.stringify(rows)]);
    await C.setMeta("live", false);
    C.forgetLive();
    let after = null;
    if (supplyFn) {
      after = (await supplyFn()).total;
      if (after !== before) throw new C.Refuse(500, `the supply total moved: ${before} before, ${after} after`, "E_SUPPLY");
    }
    // the credit archive in Pepe's keys (his loans.json "credit" is keyed by the borrower's login)
    const credit = {};
    for (const [k, e] of Object.entries(st.credit || {})) {
      let login = e.login;
      if (k.startsWith("u:")) {
        const u = await C.account({ userId: k.slice(2) });
        login = (u && (u.camfrogUsername || u.username)) || login;
      }
      if (!login) continue;
      const kk = C.low(login);
      credit[kk] = Object.fromEntries(Object.entries(e.h || {}).map(([f, n]) => [f, Math.trunc(Number(n || 0)) + Math.trunc(Number((credit[kk] || {})[f] || 0))]));
    }
    const vaults = {};
    for (const k of V.SITE_KEYS) if (st.vaults[k] !== undefined) vaults[k] = st.vaults[k];
    const res = { ok: true, key, markets: st.markets, loans: st.loans, requests: st.requests, credit, vaults,
                  seq: { market: (await C.meta("seq:market")) || 0, loan: (await C.meta("seq:loan")) || 0, request: (await C.meta("seq:request")) || 0 },
                  totals: totalsOf(st), digest: digestOf(st), pots: sum, supply_before: before, supply_after: after, backup };
    await require("../pools")._recordMove(mk, { kind: "rollback", flow: "rollback", why: "capital back to Pepe", via: C.str(actor, 40) || "pepe", legs, net: a.net, ts: a.ts, result: res });
    await require("../pools")._bumpRev();
    const rb = (await C.meta("rollbacks")) || [];
    rb.push({ key, at: Date.now(), pots: sum, actor: C.str(actor, 40) });
    await C.setMeta("rollbacks", rb.slice(-20));
    const imp = await C.meta("imported");
    if (imp) await C.setMeta("imported", Object.assign({}, imp, { rolled_back: { key, at: Date.now() } }));
    await C.bumpRev();
    return res;
  });
  C.forgetLive();
  console.log(`[capital] ROLLBACK ${key}: ${out.totals.markets} market(s) (${out.pots} PAT in pots), ${out.totals.loans} Reserve loan(s) and the vault book handed back to Pepe (backup ${backup})`);
  return out;
}

// ── supply: the market pots ──
async function supplyRows(rows) {
  if (!(await C.live())) return rows;
  const keep = (rows || []).filter((p) => String(p.key || "") !== "markets");
  const t = Number((await require("../dbUtils").getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM pools WHERE key LIKE 'market:%'"))[0].t) || 0;
  if (t > 0) keep.push({ key: "markets", label: "🔮 Prediction-market pots", amount: t });
  return keep;
}

// ── Pepe's mirror ──
async function botState(b) {
  const r = await C.rev();
  const base = { ok: true, live: await C.live(), enabled: await C.enabled(), rev: r };
  if (b.since_rev !== undefined && Number(b.since_rev) === r) return Object.assign(base, { same: true });
  const st = await stateAll({ recentDays: 7 });
  const vaults = {};
  for (const k of V.SITE_KEYS) if (st.vaults[k] !== undefined) vaults[k] = st.vaults[k];
  return Object.assign(base, { markets: st.markets, loans: st.loans, requests: st.requests, vaults, seq: { market: await C.meta("seq:market"), loan: await C.meta("seq:loan") } });
}

// ── the website's forms ──
/** /act cmd=stash stake|unstake while the vaults live here. -> reply | null (not ours). */
async function stashForm(userId, words) {
  if (!(await C.live())) return null;
  const sub = C.low(words[0]);
  if (!["stake", "unstake"].includes(sub)) return null;
  // 1.99wy: stashes (and so their vault positions) belong to the ACCOUNT - no chat login needed
  const S = require("../stashes");
  const me = await S.actorOf({ userId });
  if (!me.userId) return "Couldn't find your account.";
  const u = { userId: me.userId, username: me.username, camfrogUsername: me.login };
  let s;
  try { s = await S.find(me, words[1], { ownerOnly: true }); } catch (e) { return e.message; }
  const vault = String(words[3] || "").toLowerCase().replace("marketmaker", "mm").replace("market", "mm");
  const all = C.low(words[2]) === "all";
  const amount = all ? (sub === "stake" ? S.free(s) : 0) : S.parseAmount(words[2]);
  const actor = { userId: u.userId, username: u.username, login: u.camfrogUsername || S.acctKey(u.userId), via: "web" };
  const res = await act("vaults", { verb: sub, actor, args: { stash: s.id, vault: vault || (sub === "stake" ? "auto" : ""), amount, all: sub === "unstake" && all } });
  if (!res.ok) return res.error || "Couldn't queue that — nothing moved.";
  const when = new Date(Number(res.next_epoch || 0) * 1000).toISOString().slice(11, 16);
  if (sub === "stake") return `🏦 PAT ${C.fmt(res.item.amount)} from ${s.owner_name}/${s.name} goes into ${V.LABEL[res.item.vault]} at the next cut-off (${when} UTC), at that day's share price.`;
  return `🏦 Unstaking ~PAT ${C.fmt(res.item.value)} from ${V.LABEL[res.item.vault]} at the next cut-off (${when} UTC); it lands back in ${s.name}.`;
}

// ── routes ──
/** Phase 5's oracle (oracle.js, docs/oracle-contract.md): the LMSR markets settle on the site once they live here. */
function registerOracle() {
  try {
    require("../oracle").registerResolver("market", {
      owner: async () => ((await C.live().catch(() => false)) ? "site" : "pepe"),
      decidable: async (ref) => {
        const m = await M.getMarket(ref).catch(() => null);
        return !!m && ["open", "closed"].includes(m.status);
      },
      // actor (1.99uc): an admin's settle from /admin/oracle passes its own; the window's settle is Pepe's judge
      settle: async (ref, outcome, key, pepeLogin, actor) => act("markets", { verb: "settle", idem: `oracle-${key}`.slice(0, 120).replace(/[^A-Za-z0-9_.:@\-]/g, "-"),
        actor: actor || { pepe: true, login: pepeLogin || "pepe", via: "oracle" }, args: { ref, outcome } }),
      participants: async (ref) => {
        const m = await M.getMarket(ref).catch(() => null);
        if (!m) return [];
        return [m.creator, ...Object.values(m.positions || {}).map((p) => p.nick)].filter(Boolean).map((x) => C.low(x));
      },
    });
  } catch (e) { console.error("[capital] oracle resolver:", e.message); }
}

function register(app, { isBotToken, addUser, patSupply }) {
  if (patSupply) supplyFn = patSupply;
  registerOracle();
  C.init().then(() => {
    const iv = setInterval(() => tick().catch((e) => console.error("[capital] tick:", e.message)), 15000);
    if (iv.unref) iv.unref();
  }).catch((e) => console.error("[capital] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (C.isRefuse(e)) return res.status(e.status).json(Object.assign({ ok: false, error: e.message, code: e.code }, e.extra || {}));
      console.error(`[capital] ${req.path}:`, e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  app.post("/api/capital/bot/state", bot((b) => botState(b)));
  app.post("/api/capital/bot/op", bot((b) => act(String(b.engine || ""), b)));
  app.post("/api/capital/bot/op-status", bot(async (b) => ({ ok: true, result: await C.opStatus(b.key) })));
  app.post("/api/capital/bot/config", bot((b) => putConfig(b.cfg)));
  // the cutover export (markets with their trades and price history, every Reserve loan, the vault book) is bigger than the
  // global 100 KB JSON limit - index.js skips this path for the big parser here (the pools 413, 1.99sy)
  app.post("/api/capital/admin/import", require("express").json({ limit: "32mb" }), bot((b) => importFromPepe(b)));
  app.post("/api/capital/admin/export", bot(() => exportState()));
  app.post("/api/capital/admin/rollback", bot((b) => rollbackToPepe({ key: b.key, actor: b.actor })));
  // STAGING ONLY - the rehearsal's test clock: run the 04:00 UTC cut-off now, make a Reserve loan N seconds overdue, close a
  // market now; then one tick. Never registered on prod (no STAGING env).
  if (process.env.STAGING) {
    app.post("/api/capital/admin/test-clock", bot(async (b) => {
      if (!(await C.live())) return { ok: false, code: "not_live" };
      const out = {};
      await C.tx(async () => {
        if (b.epoch_now) {
          const d = await V.load();
          d.next_epoch = C.nowS() - 1;
          await V.store(d);
          out.epoch = true;
        }
        if (b.loan) {
          const ln = await C.load("loan", b.loan);
          if (ln && ln.status === "active") {
            ln.due = C.nowS() - Math.max(0, Number(b.due_ago_s) || 0);
            ln.next_collect = 0;
            await C.save("loan", ln, ln.due);
            out.loan = { id: ln.id, due: ln.due };
          }
        }
        if (b.market) {
          const m = await C.load("market", b.market);
          if (m && m.status === "open") {
            m.closes = C.nowS() - 1;
            await M.put(m);
            out.market = m.id;
          }
        }
        const imp = await C.meta("imported");
        if (imp) await C.setMeta("imported", Object.assign({}, imp, { at: 0 }));
        await C.bumpRev();
      });
      await tick();
      await publishAll().catch(() => {});
      return Object.assign({ ok: true }, out, { vaults: await V.load() });
    }));
  }

  const admin = async (req, res) => {
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await require("../dbUtils").getQuery("SELECT class, username FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!require("../siteperms").can(row, "econ.backend_cutover")) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    return row;
  };
  app.get("/api/admin/capital", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(await admin(req, res))) return;
    try {
      const st = await exportState();
      const ops = await require("../dbUtils").getQuery("SELECT key, op, ref, ts, via FROM capital_ops ORDER BY ts DESC LIMIT 60");
      res.json(Object.assign({}, st, { markets: st.markets.slice(-60), ops, rollbacks: (await C.meta("rollbacks")) || [] }));
    } catch (e) { console.error("[capital] admin view:", e); res.status(500).json({ ok: false, error: "failed" }); }
  });
  app.post("/api/admin/capital-backend", addUser, async (req, res) => {
    const me = await admin(req, res);
    if (!me) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("../middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    if (await C.live()) return res.status(409).json({ ok: false, error: "The site owns the markets, Reserve loans and vaults now - roll back from Pepe (docs/capital-cutover-runbook.md)." });
    await C.setMeta("enabled", !!(req.body || {}).on);
    console.log(`[capital] backend switch ${(req.body || {}).on ? "ON" : "OFF"} by ${me.username}`);
    res.json({ ok: true, enabled: await C.enabled() });
  });
}

module.exports = { register, registerOracle, act, tick, putConfig, importFromPepe, exportState, rollbackToPepe, supplyRows, stashForm, botState, digestOf, totalsOf, factsOf,
                   publishAll, _setSupplyFn: (f) => { supplyFn = f; } };
