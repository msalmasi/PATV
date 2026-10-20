// fed/service.js — backend migration P4-1: the Federal Reserve's ONE-OFF (event) operations on the site, so the Fed has a
// single writer. docs/fed-events-cutover-runbook.md.
//
// Phase 4 (policy/*) moved the clock-driven engines (the waterfall, the daily release, the monetary day, the burn). What was
// still Pepe's: the Fed's EVENT operations and their books - the admin mint (`!econ mint`, Fed only), the grants (`!econ fund`),
// the Fed loans (`!econ fedloan`, any loan pool; the Bank's default backstop), flash liquidity (a Fed loan at the moment of a
// shortfall, repaid from the Bank's loan repayments), the manual early repayment, the waterfall's loan bookings, the seed and
// restore mints, the donation mints - plus the journal (`econ_layers.fed_mints / fed_grants / fed_loans / fed_loan_repaid`),
// the monthly mint caps and the Fed band. Their PAT already moved on the site's pools (Phase 1) and their protocol shares on
// the site's share book (Phase 3), but the decisions, the caps and the journal were Pepe's: two writers (Pepe's event mints
// and the site scheduler's floor / issuance mints) could overshoot a monthly cap when two mints landed in the same seconds.
//
// Once live (the cutover: Pepe's journal imported here, sha256 + totals checked, the supply unchanged), THIS module is the
// only writer: every op is ONE keyed dbUtils.tx - check the caps and the band, move the legs, journal - and the scheduler's
// own floor / issuance mints (policy/apply.fedMint) go through mintInTx() too. dbUtils.tx is the one transaction primitive
// (a global chain + BEGIN IMMEDIATE on the shared connection): two transactions never interleave, so a cap checked inside
// one can't be passed by another landing in the same second.
//
// Tables
//   fed_meta      key PK: enabled (the site's switch: may Pepe hand the Fed over?), live (the site owns the Fed's books),
//                 imported / rollbacks (the cutover answers), loan_seq (the next "FL<n>")
//   fed_records   (kind, key) PK - kind mint | grant | loan | repaid | flashrepaid; rec = the record in Pepe's own shape
//                 (pepe_layers / pepe_monetary), so his read-only mirror is a drop-in for every reader he has
//   fed_ops       op_key PK - each request's answer (a retried request gets the same answer, never a second op)
//   fed_journal   (econstore.js) - one row per mint / grant / loan, written here with every record while live
//
// Pepe (bot pepe_fedclient.py): `!econ mint / fund / fedloan / flash` keep their dry runs and texts and send the op here;
// his journal is a read-only mirror of /api/fed/bot/state. The switch: Pepe's fed_client.json + this site's fed_meta;
// local only when Pepe's switch is explicitly off (a site down with the switch on = the op is refused - admin actions).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("../dbUtils");

const P = () => require("../pools");
const E = () => require("../policy/engines");
const G = () => require("../policy/gather");

const FED = "reserve";
const INCENTIVES = "incentives";
const KINDS = ["mint", "grant", "loan", "repaid", "flashrepaid"];
const KEY_RE = /^[A-Za-z0-9_-]{6,64}$/;
const OP_RE = /^[A-Za-z0-9_.:@-]{6,120}$/;
// pepe_layers.FED_POLICIES / MINT_DESTS / TREASURY_OF_DEST
const POLICIES = ["loan", "restore", "cutover", "floor", "issuance", "admin", "donation", "seed"];
const POLICY_SOURCE = { loan: "loan", restore: "restore", cutover: "cutover" };
const MINT_DESTS = ["reserve", "incentives", "jackpot", "bank", "mm", "fortknox", "heist", "site"];
const TREASURY_OF_DEST = { jackpot: "house", bank: "bank", mm: "mm" };
// pepe_layers.LOAN_POOLS / TREASURY_CASH, pepe_monetary.FUND_CASH / FUND_TREASURY / FLASH_VAULTS
const LOAN_POOLS = { house: "jackpot", bank: "bank", mm: "mm", fortknox: "fortknox", casino: "heist" };
const TREASURY_CASH = { house: "jackpot", bank: "bank", mm: "mm" };
const FUND_CASH = { house: "jackpot", bank: "bank", mm: "mm", fortknox: "fortknox", casino: "heist", incentives: "incentives", lotto: "lotto" };
const FUND_TREASURY = { house: "house", bank: "bank", mm: "mm" };
const FLASH_VAULTS = ["bank", "house", "mm"];
const FEDLOAN_CAP = 10000000;
const ROOM_VAULT_CAP = 50000000;
// pepe_vaultlog tags
const TAG = { mint: "fed-mint", grant: "reserve fund", loan: "vault fed loan", repay: "vault fed loan repaid" };

class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || "E_REFUSED"; Object.assign(this, extra || {}); }
}

const J = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { if (s == null) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const int = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };
const fmt = (n) => { const v = int(n); const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); return v < 0 ? "-" + s : s; };
const cleanKey = (k, n = 64) => String(k == null ? "" : k).replace(/[^A-Za-z0-9_-]/g, "").slice(0, n);

// ── the clock (injectable: the tests never depend on the time of day) ──
let clockFn = () => Date.now();
const nowMs = () => clockFn();
const nowS = () => nowMs() / 1000;
function _setClock(fn) { clockFn = fn || (() => Date.now()); }

// ── store ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS fed_meta (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS fed_records (kind TEXT NOT NULL, key TEXT NOT NULL, rec TEXT NOT NULL, state TEXT, amount INTEGER,
        source TEXT, month TEXT, ts REAL, updated INTEGER, PRIMARY KEY (kind, key))`);
      await runQuery("CREATE INDEX IF NOT EXISTS fed_records_month ON fed_records (kind, month)");
      await runQuery("CREATE TABLE IF NOT EXISTS fed_ops (op_key TEXT PRIMARY KEY, op TEXT, result TEXT, created INTEGER)");
      await require("../econstore").init();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM fed_meta WHERE key = ?", [key]))[0];
  return r ? parse(r.value, null) : null;
}
async function setMeta(key, v) {
  await init();
  return runQuery("INSERT INTO fed_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, J(v)]);
}
/** May Pepe hand the Fed's books over? Default: on on staging (STAGING env), off on prod until an admin turns it on. */
async function enabled() {
  const v = await meta("enabled");
  if (v === true || v === false) return v;
  return !!process.env.STAGING;
}
let liveCache = { at: 0, v: false };
/** The site owns the Fed's books (an import ran and wasn't rolled back). Cached 2 s (the scheduler asks on every mint). */
async function live() {
  if (Date.now() - liveCache.at < 2000) return liveCache.v;
  const v = !!(await meta("live"));
  liveCache = { at: Date.now(), v };
  return v;
}
const forgetLive = () => { liveCache = { at: 0, v: false }; };

const monthOf = (ts) => new Date(Math.floor(Number(ts) || 0) * 1000).toISOString().slice(0, 7);
const sourceOf = (r) => r.source || POLICY_SOURCE[String(r.policy || "")] || r.policy || "admin";

async function getRec(kind, key) {
  const r = (await getQuery("SELECT rec FROM fed_records WHERE kind = ? AND key = ?", [kind, String(key)]))[0];
  return r ? parse(r.rec, null) : null;
}
async function putRec(kind, key, rec) {
  const amount = kind === "loan" ? int(rec.principal) : int(rec.amount);
  await runQuery(`INSERT INTO fed_records (kind, key, rec, state, amount, source, month, ts, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(kind, key) DO UPDATE SET rec = excluded.rec, state = excluded.state, amount = excluded.amount, source = excluded.source,
                    month = excluded.month, ts = excluded.ts, updated = excluded.updated`,
                 [kind, String(key), J(rec), rec.state ? String(rec.state) : null, amount, kind === "mint" ? sourceOf(rec) : null,
                  monthOf(rec.ts), Number(rec.ts) || null, Date.now()]);
  if (kind === "mint" || kind === "grant" || kind === "loan") await journalRow(kind, kind === "loan" ? rec.id : key, rec);
}
/** econstore's fed_journal row (the same derivation econstore.deriveFedJournal makes from Pepe's pushed doc). */
async function journalRow(kind, key, r) {
  await runQuery(`INSERT INTO fed_journal (id, kind, amount, pool, policy, reason, actor, state, ts, data, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, pool = excluded.pool,
      policy = excluded.policy, reason = excluded.reason, actor = excluded.actor, state = excluded.state, ts = excluded.ts,
      data = excluded.data, updated = excluded.updated`,
    [`${kind}:${key}`.slice(0, 160), kind, r.amount != null ? int(r.amount) : int(r.principal), (r.dest || r.vault || r.pool) ? String(r.dest || r.vault || r.pool).slice(0, 80) : null,
     (r.policy || r.source) ? String(r.policy || r.source).slice(0, 40) : null, r.reason ? String(r.reason).slice(0, 300) : null,
     r.actor ? String(r.actor).slice(0, 60) : null, r.state ? String(r.state).slice(0, 20) : null, Number(r.ts) || null, J(r).slice(0, 20000), Date.now()]);
}
async function recs(kind) {
  return (await getQuery("SELECT key, rec FROM fed_records WHERE kind = ? ORDER BY ts, key", [kind])).map((r) => [r.key, parse(r.rec, {})]);
}

/** Pepe's econ_layers shape (+ econ_monetary.flash_repaid): his read-only mirror and the policy engines' inputs. */
async function layersDoc() {
  await init();
  const o = (kind) => recs(kind).then((rows) => Object.fromEntries(rows));
  return { fed_mints: await o("mint"), fed_grants: await o("grant"), fed_loans: await o("loan"), fed_loan_repaid: await o("repaid"),
           fed_loan_seq: int(await meta("loan_seq")), flash_repaid: await o("flashrepaid") };
}

// ── the numbers every op checks ──
/** The numbers an op checks: the engines' config (policy/source.js) + Pepe's per-op econ_cfg. PO-2 (T2): while Pepe owns the
 *  config his per-op econ_cfg wins (as before) and policy/config compares the result with the site's store (the dual read,
 *  consumer fed.cfgNow); once the SITE owns it (H1) the per-op econ_cfg is IGNORED - the op must carry cfg_rev instead (op()). */
let overrideNoted = 0;
async function cfgNow(override) {
  const g = await G().config();
  const PC = require("../policy/config");
  let ov = override && typeof override === "object" && !Array.isArray(override) ? override : {};
  if (Object.keys(ov).length && (await PC.owner("cfg")) === "site") {
    if (Date.now() - overrideNoted > 600000) { overrideNoted = Date.now(); console.log("[fed] ignored Pepe's per-op econ_cfg - the site owns the economy settings (cfg_rev decides)"); }
    ov = {};
  }
  const cfg = Object.assign({}, E().DEFAULTS, g.cfg || {}, ov);
  await PC.fedDual(cfg);
  return { cfg, consts: g.consts, flags: g.flags };
}
/** PO-2: once the site owns the economy settings, a Fed op carries the config rev Pepe previewed it on (cfg_rev); an op with
 *  another rev (or none) is refused - 409 with the current values, and Pepe previews again. In the op's own transaction (an edit
 *  can't land between the check and the op). Mirror mode: nothing to check. -> null | the refusal answer */
const CFG_OPS = new Set(["mint", "grant", "loan_open"]);     // the ops that read the config (cfgNow); repayments don't
async function cfgRevRefusal(b) {
  const PC = require("../policy/config");
  const snap = await PC.snapshot({ fresh: true });
  if (snap.own.cfg.owner !== "site") return null;
  const have = b.cfg_rev === undefined || b.cfg_rev === null || b.cfg_rev === "" ? null : Number(b.cfg_rev);
  if (have === snap.rev) return null;
  return { ok: false, code: "E_CFG_REV", status: 409, rev: snap.rev, sha: snap.sha, cfg: require("../policy/cfgspec").econView(snap.cfg),
           error: have === null ? `the site owns the economy settings - send cfg_rev (now ${snap.rev})` : `the economy settings changed (rev ${have} -> ${snap.rev}) - preview again` };
}
async function mintList() {
  const rows = await getQuery("SELECT rec FROM fed_records WHERE kind = 'mint' AND ts >= ?", [nowS() - 40 * 86400]);
  return rows.map((r) => parse(r.rec, {})).filter((r) => r && typeof r === "object");
}
/** pepe_monetary._mo_cap_room: PAT `source` may still mint this UTC month (null = no cap applies). */
async function capRoom(source, conf) {
  const inp = { cfg: conf.cfg, consts: conf.consts, flags: conf.flags, mints: await mintList() };
  return E().capRoom(inp, E().C(inp), source, nowS());
}
async function mtd(conf) {
  const inp = { cfg: conf.cfg, consts: conf.consts, flags: conf.flags, mints: await mintList() };
  return E().mintsMtd(inp, nowS());
}
async function lottoOwnsPot() {
  try { return !!(await require("../lotto/service").potHasRows()); } catch (e) { return false; }
}
async function lottoPot() {
  try { return await require("../lotto/service").potBalance(); } catch (e) { return 0; }
}
/** pepe_vaults._vault_total for the cash vaults this module moves. */
async function cash(where) {
  if (where === "jackpot" || where === "house") return Math.trunc(await require("../capital/core").houseBalance());
  if (where === "lotto" && (await lottoOwnsPot())) return lottoPot();
  return P().balance(where);
}
/** The conservation base (pepe_layers._v2_conservation_base): every pool + the House + the stashes + the lotto pot. */
async function base() {
  return (await require("../policy/apply").base()) + ((await lottoOwnsPot()) ? await lottoPot() : 0);
}

// ── legs (inside the open transaction; keyed with Pepe's own leg keys) ──
async function leg(key, where, amount, why) {
  amount = Math.trunc(amount);
  if (!amount) return "none";
  if (where === "jackpot" || where === "house") {
    const id = `fed-${key}`.slice(0, 190);
    if ((await getQuery("SELECT 1 FROM jackpot_rakes WHERE jackpotId = ?", [id]))[0]) return "dup";
    if (amount < 0) {
      const h = await cash("jackpot");
      if (h < -amount) throw new Refuse(409, `the House holds ${fmt(h)} - can't take ${fmt(-amount)}`, "E_INSUFFICIENT");
    }
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [id, `fed:${String(why).slice(0, 60)}`, null, amount]);
    return "ok";
  }
  if (where === "lotto" && (await lottoOwnsPot())) {
    // the lotto pot is the lotto service's (lotto/service.js) - as escrow/ledger.js books a !donate lotto
    const LS = require("../lotto/service");
    const id = `bot:${key}`.slice(0, 110);
    if ((await getQuery("SELECT 1 FROM lotto_pot WHERE moveId = ?", [id]))[0]) return "dup";
    if (amount < 0 && (await lottoPot()) < -amount) throw new Refuse(409, "the lotto pot can't cover it", "E_INSUFFICIENT");
    const D = await LS._inTx.sellingDraw();
    await LS._inTx.potMove(id, D ? D.draw : null, amount, String(why).slice(0, 80));
    return "ok";
  }
  const p = P();
  if (!p.isPool(where)) throw new Refuse(400, `bad pool ${String(where).slice(0, 60)}`, "E_BAD_POOL");
  if (await p._inTx.seen(key)) return "dup";
  const a = await p._inTx.applyLegs(key, [{ pool: where, amount }], { kind: "move", flow: String(why).slice(0, 64), why, via: "fed" });
  await p._inTx.recordMove(key, { kind: "move", flow: String(why).slice(0, 64), why, via: "fed", legs: [{ pool: where, amount }], net: a.net, ts: a.ts,
                                  result: { ok: true, key, balances: a.after } });
  await p._inTx.bumpRev();
  return "ok";
}
/** pepe_vaults._vault_transfer(tid, src, dst, amount): "<tid>:out" then "<tid>:in". */
async function transfer(tid, src, dst, amount, why) {
  amount = Math.trunc(amount);
  if (!amount) return "none";
  const o = await leg(`${tid}:out`, src, -amount, why);
  const i = await leg(`${tid}:in`, dst, amount, why);
  return o === "dup" && i === "dup" ? "dup" : "ok";
}
/** The protocol's capital on the share book (Pepe's _vault_protocol_book: capital_ops key "vaults:proto-<key>"). */
async function protocolBook(v, amount, key, basis) {
  const CC = require("../capital/core");
  const V = require("../capital/vaults");
  if (!(await CC.live())) throw new Refuse(409, "the share book still lives in Pepe (Phase 3 first)", "E_CAPITAL_LOCAL");
  const opKey = `vaults:proto-${key}`.slice(0, 160);
  const dup = await CC.seen(opKey);
  if (dup) return Number(dup.shares || 0);
  const res = await V.protocol({ pepe: true, via: "fed" }, { vault: v, amount, basis }, { nowS: CC.nowS(), key: opKey });
  if (!res || !res.ok) throw new Refuse(409, `the share book refused ${v} ${amount}: ${(res && res.error) || "?"}`, "E_BOOK");
  await CC.record(opKey, "vaults:protocol", `${v}`, "fed", res);
  await CC.bumpRev();
  return Number(res.shares);
}

// ── ops ──

/**
 * A Fed mint (pepe_layers._fed_mint), inside the caller's transaction. args: {amount, policy, reason, actor, key, via, dest,
 * user, user_limit, econ_cfg}. -> {ok, rec, dup?} | {ok: false, cap: true, source, room, wanted, error} | throws Refuse.
 */
async function mintInTx(a) {
  await init();
  const amount = int(a.amount);
  const policy = String(a.policy || "").trim().toLowerCase();
  const reason = String(a.reason || "").trim();
  const key = cleanKey(a.key);
  const dest = String(a.dest || FED);
  if (amount <= 0) throw new Refuse(400, "mint a positive amount", "E_AMOUNT");
  if (!POLICIES.includes(policy)) throw new Refuse(400, `the Fed mints only for ${POLICIES.join(", ")} (written policy, 6.1)`, "E_POLICY");
  if (reason.length < 8) throw new Refuse(400, "a Fed mint needs a written reason (8+ characters)", "E_REASON");
  if (key.length < 6) throw new Refuse(400, "a Fed mint needs an idempotency key", "E_KEY");
  if (!MINT_DESTS.includes(dest)) throw new Refuse(400, `a Fed mint lands in ${MINT_DESTS.join(", ")} - never straight into a wallet`, "E_DEST");
  const have = await getRec("mint", key);
  if (have && (int(have.amount) !== amount || have.policy !== policy)) throw new Refuse(409, "that key was used for a different mint", "E_KEY_USED");
  if (have && have.state === "done") return { ok: true, dup: true, rec: have };
  if (!have) {
    if (policy === "admin" && dest !== FED) throw new Refuse(400, "an admin mint goes only into the Federal Reserve (1.99jz) - move it on with !econ fund", "E_DEST");
    if (policy === "issuance" && dest !== FED) throw new Refuse(400, "organic issuance mints only into the Federal Reserve (1.99kb)", "E_DEST");
  }
  const conf = await cfgNow(a.econ_cfg);
  const source = POLICY_SOURCE[policy] || policy;
  if (!have) {
    if (policy === "restore") {
      const user = a.user ? String(a.user).slice(0, 64) : "";
      if (!user || a.user_limit === undefined || a.user_limit === null) {
        throw new Refuse(400, "a restore mint names the archived account (!reserve mint <amount> restore <user> <reason>) - it is capped at what was reclaimed from that account", "E_RESTORE");
      }
      const done = (await recs("mint")).map((x) => x[1]).filter((r) => r.policy === "restore" && String(r.user || "") === user && ["pending", "done"].includes(r.state))
        .reduce((t, r) => t + int(r.amount), 0);
      if (done + amount > int(a.user_limit)) {
        throw new Refuse(409, `a restore is capped at the PAT reclaimed from that account: ${fmt(a.user_limit)} reclaimed, ${fmt(done)} already restored by mint - at most ${fmt(Math.max(0, int(a.user_limit) - done))} more`, "E_RESTORE_CAP");
      }
    }
    const room = await capRoom(source, conf);
    if (room !== null && amount > room) return { ok: false, cap: true, source, room, wanted: amount, error: `the monthly mint cap for ${source} is reached (${fmt(room)} left)` };
  }
  const ts = have ? Number(have.ts) : nowS();
  const fedBefore = await P().balance(FED);
  const before = await base();
  const tv = TREASURY_OF_DEST[dest];
  let booked = false;
  if (tv) { await protocolBook(tv, amount, `mint-${key}`, "add"); booked = true; }
  if (dest !== "site") await leg(`fedmint-${key}:in`, dest, amount, TAG.mint);
  const after = await base();
  const rec = Object.assign({}, have || {}, {
    key, ts, amount, policy, source, dest, reason: reason.slice(0, 300), actor: String(a.actor || "").slice(0, 40), state: "done",
    fed_before: have ? have.fed_before : fedBefore, pools_before: have ? have.pools_before : before, done: nowS(), pools_after: after,
    conserved: after - before === (dest === "site" ? 0 : amount), via: String(a.via || "site").slice(0, 20) });
  if (booked) rec.booked = true;
  if (a.user) rec.user = String(a.user).slice(0, 64);
  await putRec("mint", key, rec);
  return { ok: true, rec, fed: await P().balance(FED) };
}

/** A Fed grant (pepe_monetary._mo_fund_run + _mo_fund_finish): Reserve -> a protocol pool, not repayable, never minted. */
async function grantInTx(a) {
  const key = cleanKey(a.key);
  if (key.length < 6) throw new Refuse(400, "a Fed grant needs an idempotency key", "E_KEY");
  const have = await getRec("grant", key);
  if (have && have.state === "done") return { ok: true, dup: true, rec: have, fed: await P().balance(FED) };
  const pool = String(a.pool || "");
  let dest, rid = null;
  if (pool === "room") {
    rid = String(a.rid || "").slice(0, 80);
    dest = "room:" + rid;
    if (!rid || !P().isPool(dest)) throw new Refuse(400, "bad pad vault", "E_POOL");
  } else {
    dest = FUND_CASH[pool];
    if (!dest) throw new Refuse(400, "grant into one of house | bank | mm | fortknox | casino | incentives | lotto | room:<room id> - never a wallet", "E_POOL");
  }
  const amount = int(a.amount);
  if (amount <= 0) throw new Refuse(400, "grant a positive whole amount", "E_AMOUNT");
  const reason = String(a.reason || "").trim();
  if (reason.length < 8) throw new Refuse(400, "a Fed grant needs a written reason (8+ characters)", "E_REASON");
  const conf = await cfgNow(a.econ_cfg);
  const c = E().C({ cfg: conf.cfg, consts: conf.consts });
  // the pool's cap (Fort Knox / the Casino vault: fixed or % of the week's target; a pad vault: room_vault_cap)
  if (!have && (pool === "fortknox" || pool === "casino" || pool === "room")) {
    const cap = pool === "room" ? c.int("room_vault_cap", ROOM_VAULT_CAP)
      : E().heistCap({ cfg: conf.cfg, consts: conf.consts, flags: conf.flags, mints: await mintList() }, c, pool, nowS());
    const bal = await cash(dest);
    if (amount > Math.max(0, cap - bal)) {
      throw new Refuse(409, `the pool holds ${fmt(bal)} of its ${fmt(cap)} cap - at most ${fmt(Math.max(0, cap - bal))} more fits (the rest would overflow straight on)`, "E_POOL_CAP");
    }
  }
  const fed = await P().balance(FED);
  if (!have && amount > fed) throw new Refuse(409, `the Fed holds only ${fmt(fed)} now - nothing moved`, "E_FED_SHORT");
  const floor = c.int("fed_floor", 25000000);
  const below = fed - amount < floor;
  if (!have && below && !a.ack_floor) throw new Refuse(409, `this grant takes the Fed below its ${fmt(floor)} floor - confirm it twice`, "E_FLOOR_ACK");
  const before = await base();
  const rec = Object.assign({ key, ts: nowS(), pool, dest, rid, amount, reason: reason.slice(0, 300), actor: String(a.actor || "").slice(0, 40),
                              via: String(a.via || "chat").slice(0, 20), fed_before: fed, below_floor: below, state: "pending", pools_before: before }, have || {});
  const tv = FUND_TREASURY[pool];
  if (tv && !rec.booked) { await protocolBook(tv, amount, `grant-${key}`, "add"); rec.booked = true; }
  await transfer(`fedgrant-${key}`, FED, dest, amount, TAG.grant);
  rec.state = "done";
  rec.done = nowS();
  delete rec.error;
  rec.pools_after = await base();
  rec.conserved = rec.pools_after === rec.pools_before;
  await putRec("grant", key, rec);
  return { ok: true, rec, fed: await P().balance(FED), floor };
}

async function outstanding() {
  return (await recs("loan")).map((x) => x[1]).filter((r) => ["pending", "open"].includes(r.state))
    .reduce((t, r) => t + (r.state === "open" ? int(r.outstanding) : int(r.principal)), 0);
}

/** A Fed loan (pepe_layers._fl_open + _fl_finish): the shortfall minted first (policy loan, capped), shares for a Treasury
 * vault's protocol capital, then the leg "fedloan-<id>". args: {key|null, vault, amount, reason, actor, auto, flash, via}. */
async function loanInTx(a, opKey) {
  const v = String(a.vault || "");
  const amount = int(a.amount);
  const flash = !!a.flash, auto = !!a.auto;
  const k = a.key ? cleanKey(a.key, 56) : "";
  let lid = k ? `FL-${k}` : null;
  let rec = lid ? await getRec("loan", lid) : null;
  if (rec && rec.state !== "pending") return { ok: true, dup: true, rec, out: await outstanding() };
  const conf = await cfgNow(a.econ_cfg);
  const c = E().C({ cfg: conf.cfg, consts: conf.consts });
  if (!rec) {
    if (!LOAN_POOLS[v] || amount <= 0 || (flash && !TREASURY_CASH[v])) throw new Refuse(400, "bad loan", "E_LOAN");
    const reason = String(a.reason || "").trim();
    if (!auto && reason.length < 8) throw new Refuse(400, "a Fed loan needs a written reason (8+ characters)", "E_REASON");
    const cap = c.int("fedloan_cap", FEDLOAN_CAP);
    const room = Math.max(0, cap - (await outstanding()));
    if (amount > room) throw new Refuse(409, `over the ${fmt(cap)} outstanding cap (${fmt(room)} left)`, "E_LOAN_CAP", { room });
    if (!TREASURY_CASH[v]) {                       // Fort Knox / the Casino vault: up to the pool's cap
      const pc = E().heistCap({ cfg: conf.cfg, consts: conf.consts, flags: conf.flags, mints: await mintList() }, c, v, nowS());
      const bal = await cash(LOAN_POOLS[v]);
      if (amount > Math.max(0, pc - bal)) throw new Refuse(409, `the pool holds ${fmt(bal)}, ${fmt(pc)} cap - a loan would overflow straight on`, "E_POOL_CAP");
    }
    if (!lid) {
      const seq = int(await meta("loan_seq")) + 1;
      await setMeta("loan_seq", seq);
      lid = `FL${seq}`;
    }
    const fed = await P().balance(FED);
    rec = { id: lid, vault: v, principal: amount, outstanding: 0, reason: reason.slice(0, 300), actor: String(a.actor || "").slice(0, 40), ts: nowS(),
            state: "pending", auto, shares: (!auto || flash) && !!TREASURY_CASH[v], flash, mint: Math.max(0, amount - fed), mint_key: `fl-${lid}`.slice(0, 64),
            pools_before: await base(), repayments: [] };
  }
  const amt = int(rec.principal);
  if (rec.mint > 0 && !rec.minted) {
    const m = await mintInTx({ amount: rec.mint, policy: "loan", reason: `${rec.id} to the ${v}: ${rec.reason}`.slice(0, 300), actor: rec.actor, key: rec.mint_key,
                               via: a.via, econ_cfg: a.econ_cfg });
    if (!m.ok) return Object.assign({ loan_refused: true }, m);       // the loan source's cap: nothing journaled, nothing moved
    rec.minted = true;
  }
  if (rec.shares && !rec.booked) { await protocolBook(v, amt, `fedloan-${rec.id}`, "add"); rec.booked = true; }
  await transfer(`fedloan-${rec.id}`, FED, LOAN_POOLS[v], amt, TAG.loan);
  rec.state = "open";
  rec.outstanding = amt;
  rec.opened = nowS();
  delete rec.error;
  rec.pools_after = await base();
  rec.conserved = rec.pools_after - rec.pools_before === int(rec.mint);
  rec.via = String(a.via || "system").slice(0, 20);
  await putRec("loan", rec.id, rec);
  return { ok: true, rec, out: await outstanding(), fed: await P().balance(FED), op_key: opKey };
}

/** Book `amount` against vault v's open loans, oldest first (pepe_layers._fl_apply_repay - the waterfall's step 1 / the daily
 * release's overflow legs already moved the PAT). Once per mark "<period>-<vault>". -> applied. */
async function repaidInTx({ mark, vault, amount, epoch }) {
  mark = String(mark || "").slice(0, 120);
  if (!mark) throw new Refuse(400, "a repayment needs its mark", "E_KEY");
  const have = await getRec("repaid", mark);
  if (have) return { ok: true, dup: true, applied: int(have.applied), rec: have };
  let left = int(amount);
  const t = nowS();
  const loans = (await recs("loan")).map((x) => x[1]).filter((r) => r.state === "open" && r.vault === vault)
    .sort((x, y) => (Number(x.ts) || 0) - (Number(y.ts) || 0));
  for (const r of loans) {
    if (left <= 0) break;
    const pay = Math.min(left, int(r.outstanding));
    if (pay <= 0) continue;
    r.outstanding = int(r.outstanding) - pay;
    (r.repayments = r.repayments || []).push({ epoch: epoch || mark.replace(/-[a-z]+$/, ""), amount: pay, ts: t });
    if (r.outstanding <= 0) { r.state = "repaid"; r.repaid = t; }
    left -= pay;
    await putRec("loan", r.id, r);
  }
  const rec = { amount: int(amount), applied: int(amount) - left, ts: t };
  await putRec("repaid", mark, rec);
  return { ok: true, applied: rec.applied, rec };
}

/** An admin's early repayment of a Fort Knox / Casino loan from that pool (pepe_layers._fl_repay_run). */
async function loanRepayInTx(a) {
  const key = cleanKey(a.key);
  if (key.length < 6) throw new Refuse(400, "a repayment needs a key", "E_KEY");
  const r = await getRec("loan", String(a.id || ""));
  const v = r ? r.vault : String(a.vault || "");
  const mk = `manual-${key}-${v}`;
  const have = await getRec("repaid", mk);
  if (have) return { ok: true, dup: true, rec: r, repaid: have };
  if (!r || r.state !== "open") throw new Refuse(409, `${a.id} isn't open any more`, "E_LOAN_STATE");
  if (TREASURY_CASH[v]) throw new Refuse(409, `${r.id} is a Treasury loan: the weekly waterfall repays it`, "E_TREASURY_LOAN");
  const amt = Math.min(int(a.amount), int(r.outstanding), await cash(LOAN_POOLS[v]));
  if (amt <= 0) throw new Refuse(409, `the pool can't repay ${r.id} now`, "E_SHORT");
  const t = nowS();
  await transfer(`flrepay-${key}`, LOAN_POOLS[v], FED, amt, TAG.repay);
  r.outstanding = int(r.outstanding) - amt;
  (r.repayments = r.repayments || []).push({ key, amount: amt, ts: t, by: String(a.actor || "").slice(0, 40) });
  if (r.outstanding <= 0) { r.state = "repaid"; r.repaid = t; }
  await putRec("loan", r.id, r);
  const rp = { amount: amt, applied: amt, ts: t, state: "done", lid: r.id, vault: v, key };
  await putRec("repaid", mk, rp);
  return { ok: true, rec: r, repaid: rp, amount: amt };
}

/** Repay vault v's open FLASH loans from `amount` that just came back to it (pepe_monetary._mo_flash_repay: the Bank's loan
 * repayments). The protocol's shares for that capital leave with it, at the price before it left. Once per key. */
async function flashRepayInTx(a) {
  const key = cleanKey(a.key, 80);
  const v = String(a.vault || "");
  if (key.length < 4 || !FLASH_VAULTS.includes(v)) throw new Refuse(400, "bad flash repayment", "E_BAD");
  const have = await getRec("flashrepaid", key);
  if (have) return { ok: true, dup: true, amount: int(have.amount), rec: have };
  const loans = (await recs("loan")).map((x) => x[1]).filter((r) => r.state === "open" && r.vault === v && r.flash)
    .sort((x, y) => (Number(x.ts) || 0) - (Number(y.ts) || 0));
  const owed = loans.reduce((t, r) => t + int(r.outstanding), 0);
  const pay = Math.min(int(a.amount), owed, await cash(TREASURY_CASH[v]));
  if (pay <= 0) return { ok: true, amount: 0 };
  await protocolBook(v, -pay, `flrepay-${key}`, "shrink");            // the price BEFORE the capital leaves
  await transfer(`flrepay-${key}`, TREASURY_CASH[v], FED, pay, "vault fed loan repaid");
  let left = pay;
  const t = nowS();
  for (const r of loans) {
    if (left <= 0) break;
    const p = Math.min(left, int(r.outstanding));
    r.outstanding = int(r.outstanding) - p;
    (r.repayments = r.repayments || []).push({ key, amount: p, ts: t });
    if (r.outstanding <= 0) { r.state = "repaid"; r.repaid = t; }
    left -= p;
    await putRec("loan", r.id, r);
  }
  const rec = { amount: pay, ts: t, state: "done", vault: v };
  await putRec("flashrepaid", key, rec);
  return { ok: true, amount: pay, rec };
}

// ── donations: the site credits the donor (stripebilling / cryptopay, promo split by donationpromo.creditTerms) and books the
// claim "mint:donation" {amount, meta: {bonus, usd_cents, via, ...}}; while live THIS module journals the two mints Pepe's
// _mo_settle_donation journaled - "<cid>-w" (policy donation, dest "site": the wallet already holds it, no pool leg) and
// "<cid>-b" (the incentive bonus, into the incentive budget) - and settles the claim, all in one transaction. ──
function donationKeys(claimId) {
  const cid = cleanKey(claimId, 56);
  return { cid, w: `${cid}-w`, b: `${cid}-b` };
}
async function settleDonationInTx(c) {
  const { cid, w, b } = donationKeys(c.claimId);
  const amt = int(c.amount);
  if (!cid || amt <= 0) {
    await runQuery("UPDATE reserve_claims SET settled = 1 WHERE claimId = ? AND settled = 0", [String(c.claimId)]);
    return { ok: true, none: true };
  }
  let m = parse(c.meta, {});
  if (!m || typeof m !== "object") m = {};
  const bonus = Math.max(0, int(m.bonus));
  const usd = int(m.usd_cents);
  const who = String(c.username || c.userId || "").slice(0, 40);
  const reason = `donation $${(usd / 100).toFixed(2)} by ${who || "a supporter"} (${cid})`;
  const actor = String(m.via || "").toLowerCase() === "crypto" ? "crypto" : "stripe";
  const r1 = await mintInTx({ amount: amt, policy: "donation", reason, actor, key: w, dest: "site", user: c.userId, via: "site" });
  let r2 = null;
  if (bonus) r2 = await mintInTx({ amount: bonus, policy: "donation", reason: reason + " - incentives bonus", actor, key: b, dest: INCENTIVES, via: "site" });
  await runQuery("UPDATE reserve_claims SET settled = 1 WHERE claimId = ? AND settled = 0", [String(c.claimId)]);
  return { ok: true, wallet: r1.rec, bonus: r2 && r2.rec };
}
let sweeping = false;
async function donationSweep() {
  if (sweeping) return 0;
  sweeping = true;
  try {
    if (!(await live())) return 0;
    let rows;
    try {
      rows = await getQuery(`SELECT c.claimId, c.flow, c.amount, c.userId, c.meta, u.username FROM reserve_claims c LEFT JOIN users u ON u.userId = c.userId
                             WHERE c.flow = 'mint:donation' AND c.settled = 0 AND COALESCE(c.queued,0) = 0 ORDER BY c.created, c.rowid LIMIT 100`);
    } catch (e) { return 0; }
    let n = 0;
    for (const c of rows) {
      try { await tx(() => settleDonationInTx(c)); n++; } catch (e) { console.error(`[fed] donation ${c.claimId}: ${e.message}`); }
    }
    if (n) console.log(`[fed] journaled ${n} donation mint(s)`);
    return n;
  } finally { sweeping = false; }
}

// ── the bot's op route: one keyed request, one transaction ──
const OPS = {
  mint: (a) => mintInTx(a),
  grant: (a) => grantInTx(a),
  loan_open: (a, k) => loanInTx(a, k),
  loan_repay: (a) => loanRepayInTx(a),
  loan_repaid: (a) => repaidInTx(a),
  flash_repay: (a) => flashRepayInTx(a),
};
async function op(b) {
  await init();
  const name = String(b.op || "");
  const opKey = String(b.op_key || "");
  if (!OPS[name]) return { ok: false, code: "E_OP", error: "unknown op" };
  if (!OP_RE.test(opKey)) return { ok: false, code: "E_KEY", error: "bad op key" };
  if (!(await live())) return { ok: false, code: "not_live", error: "the Fed's books still live in Pepe" };
  const prev = (await getQuery("SELECT result FROM fed_ops WHERE op_key = ?", [opKey]))[0];
  if (prev) return Object.assign(parse(prev.result, {}), { replay: true });
  const a = Object.assign({}, b.args || {}, b.econ_cfg ? { econ_cfg: b.econ_cfg } : {});
  let out;
  try {
    out = await tx(async () => {
      const stale = CFG_OPS.has(name) ? await cfgRevRefusal(b) : null;
      if (stale) throw Object.assign(new Refuse(409, stale.error, "E_CFG_REV"), { answer: stale });
      const r = await OPS[name](a, opKey);
      // a cap refusal moves nothing - the transaction rolls back (a loan's journal included) and the answer is kept
      if (r && r.ok === false) throw Object.assign(new Refuse(409, r.error || "refused", r.cap ? "E_CAP" : "E_REFUSED"), { answer: r });
      await runQuery("INSERT INTO fed_ops (op_key, op, result, created) VALUES (?, ?, ?, ?)", [opKey, name, J(Object.assign({ ok: true }, r)), Date.now()]);
      return r;
    });
  } catch (e) {
    if (e instanceof Refuse || e.status) {
      const ans = Object.assign({ ok: false, code: e.code || "E_REFUSED", error: e.message }, e.answer || {});
      if (e.room !== undefined) ans.room = e.room;
      return ans;
    }
    throw e;
  }
  return Object.assign({ ok: true }, out, { doc: await layersDoc() });
}

async function botState() {
  await init();
  const conf = await cfgNow();
  return { ok: true, enabled: await enabled(), live: await live(), doc: await layersDoc(), mtd: await mtd(conf), fed: await P().balance(FED).catch(() => null),
           outstanding: await outstanding(), now: nowS() };
}

// ── the cutover: Pepe's journal -> here, once ──
function cleanPayload(text) {
  const x = parse(text, null);
  if (!x || typeof x !== "object" || x.v !== 1) throw new Refuse(400, "bad export", "E_PAYLOAD");
  const obj = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : {});
  const out = { fed_mints: obj(x.fed_mints), fed_grants: obj(x.fed_grants), fed_loans: obj(x.fed_loans), fed_loan_repaid: obj(x.fed_loan_repaid),
                flash_repaid: obj(x.flash_repaid), fed_loan_seq: int(x.fed_loan_seq) };
  for (const [k, r] of Object.entries(out.fed_mints)) if (!r || typeof r !== "object" || !k) throw new Refuse(400, `bad mint ${k}`, "E_PAYLOAD");
  for (const [k, r] of Object.entries(out.fed_loans)) if (!r || typeof r !== "object" || String(r.id || k) !== k) throw new Refuse(400, `bad loan ${k}`, "E_PAYLOAD");
  return out;
}
/** The totals both sides compare (Pepe's pepe_fedclient.fed_totals computes the same from the same payload). */
function totalsOf(x) {
  const mints = Object.values(x.fed_mints), grants = Object.values(x.fed_grants), loans = Object.values(x.fed_loans);
  return { mints: mints.length, mint_sum: mints.reduce((t, r) => t + int(r.amount), 0), grants: grants.length, grant_sum: grants.reduce((t, r) => t + int(r.amount), 0),
           loans: loans.length, loan_principal: loans.reduce((t, r) => t + int(r.principal), 0),
           loan_outstanding: loans.filter((r) => r.state === "open").reduce((t, r) => t + int(r.outstanding), 0),
           repaid: Object.keys(x.fed_loan_repaid).length, flash_repaid: Object.keys(x.flash_repaid).length, seq: x.fed_loan_seq };
}
function pendingOf(x) {
  const out = [];
  for (const [k, r] of Object.entries(x.fed_mints)) if (r.state === "pending") out.push(`mint ${k}`);
  for (const [k, r] of Object.entries(x.fed_grants)) if (r.state === "pending") out.push(`grant ${k}`);
  for (const [k, r] of Object.entries(x.fed_loans)) if (r.state === "pending") out.push(`loan ${k}`);
  for (const [k, r] of Object.entries(x.fed_loan_repaid)) if (r && r.state === "moving") out.push(`repayment ${k}`);
  for (const [k, r] of Object.entries(x.flash_repaid)) if (r && r.state === "moving") out.push(`flash repayment ${k}`);
  return out;
}
async function supplyTotal() {
  try { return int((await require("../supply").patSupply()).total); } catch (e) { return null; }
}
/**
 * body: {key, payload (JSON text), digest (sha256 of payload), totals, actor, dry}. Checks: the switch on, the pools and the
 * share book live here, the digest, the totals, nothing half-done. Then (not on a dry run) a verified DB backup and ONE
 * transaction: Pepe's records written, the site scheduler's own mints (policy_mints) Pepe never mirrored added, everything
 * re-read and compared, the supply read before and after (it must not move by one PAT: nothing moves), live on. A dry run
 * does all of it and rolls back (the rehearsal against a read-only copy of prod's journal).
 */
async function importFromPepe(b) {
  await init();
  const key = String((b && b.key) || "");
  if (!OP_RE.test(key)) throw new Refuse(400, "bad key", "E_KEY");
  const dry = !!(b && b.dry);
  if (!(await enabled())) throw new Refuse(409, "the Fed backend is switched off on this site", "E_FEATURE_OFF");
  const payload = String((b && b.payload) || "");
  const digest = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  if (!payload || digest !== String(b.digest || "")) throw new Refuse(400, "digest mismatch", "E_DIGEST");
  const done = await meta("imported");
  if (!dry && done && done.key === key && !done.rolled_back) {
    if (done.digest === digest) return Object.assign({ ok: true, already: true }, done);
    throw new Refuse(409, "this cutover key was already used with a different export", "E_ALREADY");
  }
  if (!dry && (await live())) throw new Refuse(409, "the site already owns the Fed's books", "E_ALREADY");
  if (!(await P().live())) throw new Refuse(409, "the pools still live in Pepe (Phase 1 first)", "E_POOLS_LOCAL");
  if (!(await require("../capital/core").live())) throw new Refuse(409, "the share book still lives in Pepe (Phase 3 first): grants, loans and mints into the House / Bank / MM book protocol shares there", "E_CAPITAL_LOCAL");
  const x = cleanPayload(payload);
  const exp = totalsOf(x);
  const tt = (b && b.totals) || {};
  for (const k of Object.keys(exp)) if (int(tt[k]) !== exp[k]) throw new Refuse(400, `totals don't match: ${k} ${exp[k]} in the export vs ${tt[k]}`, "E_TOTALS");
  const pend = pendingOf(x);
  if (pend.length) throw new Refuse(409, `half-done in Pepe: ${pend.slice(0, 5).join(", ")} - let it finish first`, "E_PENDING");
  const backup = dry ? null : await require("../dbbackup").backupDb("pre-fed-import");
  const DRY = Symbol("dry");
  let answer;
  try {
    answer = await tx(async () => {
      if (!dry && (await meta("live"))) throw new Refuse(409, "already imported", "E_ALREADY");
      const s0 = await supplyTotal();
      const base0 = await base();
      await runQuery("DELETE FROM fed_records");
      for (const [k, r] of Object.entries(x.fed_mints)) await putRec("mint", k, r);
      for (const [k, r] of Object.entries(x.fed_grants)) await putRec("grant", k, r);
      for (const [k, r] of Object.entries(x.fed_loans)) await putRec("loan", k, r);
      for (const [k, r] of Object.entries(x.fed_loan_repaid)) await putRec("repaid", k, r || {});
      for (const [k, r] of Object.entries(x.flash_repaid)) await putRec("flashrepaid", k, r || {});
      await setMeta("loan_seq", Math.max(x.fed_loan_seq, int(await meta("loan_seq"))));
      // the scheduler's own floor / issuance mints (Phase 4 live) Pepe hasn't mirrored yet
      let merged = 0;
      try {
        for (const r of await getQuery("SELECT key, rec FROM policy_mints")) {
          if (r.key in x.fed_mints) continue;
          const rec = parse(r.rec, null);
          if (rec) { await putRec("mint", r.key, rec); merged++; }
        }
      } catch (e) { /* no scheduler table */ }
      // re-read and compare
      const doc = await layersDoc();
      const back = totalsOf({ fed_mints: Object.fromEntries(Object.entries(doc.fed_mints).filter(([k]) => k in x.fed_mints)), fed_grants: doc.fed_grants,
                              fed_loans: doc.fed_loans, fed_loan_repaid: doc.fed_loan_repaid, flash_repaid: doc.flash_repaid, fed_loan_seq: x.fed_loan_seq });
      for (const k of Object.keys(exp)) if (back[k] !== exp[k]) throw new Refuse(500, `read back ${k} ${back[k]} vs ${exp[k]}`, "E_VERIFY");
      const s1 = await supplyTotal();
      const base1 = await base();
      if (s0 !== s1 || base0 !== base1) throw new Refuse(500, `the supply moved during the import (${s0} -> ${s1}, pools ${base0} -> ${base1})`, "E_SUPPLY");
      const out = { ok: true, key, digest, totals: exp, merged_site_mints: merged, supply: s1, pools: base1, backup, dry, at: Date.now(),
                    actor: String((b && b.actor) || "pepe").slice(0, 40) };
      if (dry) throw Object.assign(new Error("dry"), { [DRY]: out });
      await setMeta("imported", out);
      await setMeta("live", true);
      return out;
    });
  } catch (e) {
    if (e && e[DRY]) return Object.assign({}, e[DRY], { rolled_back: true });
    throw e;
  }
  forgetLive();
  console.log(`[fed] CUTOVER ${key}: the Fed's books live on the site (${exp.mints} mints, ${exp.grants} grants, ${exp.loans} loans; supply ${answer.supply} unchanged)`);
  return answer;
}
/** Everything in Pepe's shape + sha256 + totals (the runbook's before / after, the way back). */
async function exportState() {
  await init();
  const d = await layersDoc();
  const x = { v: 1, fed_mints: d.fed_mints, fed_grants: d.fed_grants, fed_loans: d.fed_loans, fed_loan_repaid: d.fed_loan_repaid, flash_repaid: d.flash_repaid,
              fed_loan_seq: d.fed_loan_seq };
  const payload = JSON.stringify(x);
  return { ok: true, live: await live(), enabled: await enabled(), payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
           totals: totalsOf(x), imported: await meta("imported") };
}
/** The way back (the site answers): live off, the books handed to Pepe (he writes them into his turf store). Idempotent by key. */
async function rollback(b) {
  await init();
  const key = String((b && b.key) || "");
  if (!OP_RE.test(key)) throw new Refuse(400, "bad key", "E_KEY");
  const prev = (await meta("rollbacks")) || {};
  if (prev[key]) return Object.assign({ ok: true, dup: true }, prev[key], await exportState());
  if (!(await live())) throw new Refuse(409, "the site doesn't own the Fed's books", "E_NOT_LIVE");
  const ex = await tx(async () => {
    const e = await exportState();
    await setMeta("live", false);
    const imp = await meta("imported");
    if (imp) await setMeta("imported", Object.assign(imp, { rolled_back: Date.now() }));
    prev[key] = { key, at: Date.now(), actor: String((b && b.actor) || "pepe").slice(0, 40), digest: e.digest, totals: e.totals };
    await setMeta("rollbacks", prev);
    return e;
  });
  forgetLive();
  console.log(`[fed] ROLLBACK ${key}: the Fed's books back to Pepe (${ex.totals.mints} mints, ${ex.totals.loans} loans)`);
  return Object.assign({ ok: true }, prev[key], ex, { live: false });
}

// ── routes ──
function register(app, { isBotToken }) {
  init().catch((e) => console.error("[fed] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (e instanceof Refuse) return res.status(e.status && e.status < 500 ? 200 : 500).json({ ok: false, code: e.code, error: e.message });
      console.error("[fed] bot:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  app.post("/api/fed/bot/state", bot(() => botState()));
  // PO-2: a stale cfg_rev is HTTP 409 (with the current values); every other refusal stays a 200 answer
  app.post("/api/fed/bot/op", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const r = await op(b);
      res.status(r && r.code === "E_CFG_REV" ? 409 : 200).json(r);
    } catch (e) {
      if (e instanceof Refuse) return res.status(e.status && e.status < 500 ? 200 : 500).json({ ok: false, code: e.code, error: e.message });
      console.error("[fed] bot:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });
  // the export can be big (every mint ever): its own body limit (index.js skips this path)
  app.post("/api/fed/admin/import", require("express").json({ limit: "32mb" }), bot((b) => importFromPepe(b)));
  app.post("/api/fed/admin/export", bot(() => exportState()));
  app.post("/api/fed/admin/rollback", bot((b) => rollback(b)));
  const iv = setInterval(() => donationSweep().catch((e) => console.error("[fed] donations:", e.message)), 15000);
  if (iv.unref) iv.unref();
}

module.exports = { init, register, meta, setMeta, enabled, live, forgetLive, layersDoc, mintInTx, grantInTx, loanInTx, repaidInTx, loanRepayInTx,
                   flashRepayInTx, settleDonationInTx, donationSweep, donationKeys, op, botState, importFromPepe, exportState, rollback, totalsOf,
                   outstanding, capRoom, cfgNow, _setClock, nowS, Refuse, KINDS };
