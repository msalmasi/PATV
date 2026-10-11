// lotto/service.js — Pepeball owned by the SITE (1.99ml; docs/lotto-backend.md). Pepe is a thin client.
//
//   * State: lotto_draws (one row per draw: selling -> closed -> drawn -> paid, its commitment / seed / digest / numbers /
//     prize plan / payout progress), lotto_tickets, lotto_purchases (one per purchase, its key = the charge's
//     transactionId), lotto_pot (the jackpot pot: a keyed movement ledger, balance = SUM), lotto_history (past draws, in
//     Pepe's history shape, incl. the ones imported at the cutover), lotto_events (the cursor Pepe long-polls),
//     lotto_settings (lotto_backend switch, price, pot_share), lotto_imports.
//   * Money: every movement has a deterministic key and is looked up before it is made, so a retry or a restart never
//     moves anything twice:
//       purchase  transactions  <key>                     -cost   "lotto-tickets"
//                 lotto_pot     <key>:pot                 +trunc(cost x pot_share)
//                 jackpot_rakes <key>:house               +the rest (spinId lotto:T<draw>)   - the House
//       refund    transactions  <key>:refund              +cost   "lotto-late-refund"  (a purchase a crash left behind
//                                                                                        after its draw closed)
//       draw      jackpot_rakes lotto:T<d>:fixed          -fixed prizes (after the Fed flash cover, flash:house:lotto)
//                 lotto_pot     lotto:T<d>:jp             -the jackpot paid
//                 transactions  lotto:T<d>:win:<uid>:<reason>  +each player's prizes per tier ("lotto-3pb", "lotto-jackpot")
//       Pepe      lotto_pot     bot:<ref>                 +/- (!donate lotto, Fed grants, the reseed after a jackpot)
//       cutover   lotto_pot     import:<key>              +the pot Pepe held
//   * A draw saves its numbers and the whole prize plan BEFORE any money moves; pay() resumes from the saved progress.
//   * One mutex serialises every mutation; one 5 s tick closes sales, draws, pays and reopens.
//   * The page's lotto_state row (lotto.js; home, banner, og read it) is WRITTEN BY THIS SERVICE while the backend is on
//     (Pepe's /api/lotto/sync is refused then) - it is a cache of this state, no longer a mirror of Pepe's.
"use strict";
const { runQuery, getQuery } = require("../dbUtils");
const ledger = require("../ledger");
const funding = require("../funding");
const E = require("./engine");

const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US");
const S = {
  hooks: { now: () => Date.now(), updateLevel: null },
  settings: null, settingsAt: 0,
  booted: null, tick: null, lastSeq: 0, waiters: new Set(),
  snapTimer: null, rate: new Map(), payBackoff: new Map(),
};
const clock = () => S.hooks.now();
const nowSec = () => Math.floor(clock() / 1000);

let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// ── tables ──
let readyP = null;
function ensure() {
  if (readyP) return readyP;
  readyP = (async () => {
    await runQuery(`CREATE TABLE IF NOT EXISTS lotto_settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)`);
    await runQuery(`CREATE TABLE IF NOT EXISTS lotto_draws (
      draw INTEGER PRIMARY KEY, state TEXT NOT NULL, next_at INTEGER NOT NULL, close_at INTEGER NOT NULL,
      commitment TEXT NOT NULL, server_seed TEXT NOT NULL, tickets_digest TEXT, white TEXT, pb INTEGER, sold INTEGER DEFAULT 0,
      plan TEXT, progress TEXT, flags TEXT, reseed TEXT, house_at_draw INTEGER, pot_at_draw INTEGER, forced_by TEXT,
      created INTEGER, closed_at INTEGER, drawn_at INTEGER, paid_at INTEGER)`);
    await runQuery(`CREATE TABLE IF NOT EXISTS lotto_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, draw INTEGER NOT NULL, userId TEXT NOT NULL, name TEXT, w TEXT NOT NULL, pb INTEGER NOT NULL,
      purchase TEXT NOT NULL, created INTEGER)`);
    await runQuery("CREATE INDEX IF NOT EXISTS lotto_tickets_draw ON lotto_tickets (draw, userId)");
    await runQuery("CREATE INDEX IF NOT EXISTS lotto_tickets_purchase ON lotto_tickets (purchase)");
    await runQuery(`CREATE TABLE IF NOT EXISTS lotto_purchases (
      key TEXT PRIMARY KEY, draw INTEGER NOT NULL, userId TEXT NOT NULL, name TEXT, picks TEXT NOT NULL, count INTEGER NOT NULL,
      cost INTEGER NOT NULL, pot INTEGER, state TEXT NOT NULL, via TEXT, response TEXT, created INTEGER)`);
    await runQuery("CREATE INDEX IF NOT EXISTS lotto_purchases_state ON lotto_purchases (state)");
    await runQuery(`CREATE TABLE IF NOT EXISTS lotto_pot (moveId TEXT PRIMARY KEY, draw INTEGER, amount INTEGER NOT NULL, why TEXT, created INTEGER)`);
    await runQuery(`CREATE TABLE IF NOT EXISTS lotto_history (draw INTEGER PRIMARY KEY, data TEXT NOT NULL)`);
    await runQuery(`CREATE TABLE IF NOT EXISTS lotto_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)`);
    await runQuery(`CREATE TABLE IF NOT EXISTS lotto_imports (key TEXT PRIMARY KEY, result TEXT, created INTEGER)`);
    const m = await getQuery("SELECT MAX(seq) AS s FROM lotto_events");
    S.lastSeq = (m[0] && m[0].s) || 0;
  })().catch((e) => { readyP = null; throw e; });
  return readyP;
}

// ── settings ──
async function loadSettings(force) {
  if (!force && S.settings && clock() - S.settingsAt < 5000) return S.settings;
  await ensure();
  const kv = Object.fromEntries((await getQuery("SELECT key, value FROM lotto_settings")).map((r) => [r.key, r.value]));
  const price = Math.trunc(Number(kv.price));
  const share = Number(kv.pot_share);
  S.settings = {
    lotto_backend: kv.lotto_backend === "1",                 // default OFF everywhere: the cutover (import) turns it on
    price: price > 0 && price <= 100000 ? price : E.RULES.PRICE,
    pot_share: share >= 0 && share <= 1 ? share : E.RULES.POT_SHARE,
  };
  S.settingsAt = clock();
  return S.settings;
}
const SETTING_KEYS = ["lotto_backend", "price", "pot_share"];
async function setSetting(key, value, actor) {
  if (!SETTING_KEYS.includes(key)) throw new Error("unknown setting");
  await ensure();
  let v;
  if (key === "lotto_backend") v = value === true || value === 1 || ["1", "on", "true"].includes(String(value)) ? "1" : "0";
  else if (key === "price") { const n = Math.trunc(Number(value)); if (!(n > 0 && n <= 100000)) throw new Error("price 1..100000"); v = String(n); }
  else { const n = Number(value); if (!(n >= 0 && n <= 1)) throw new Error("pot_share 0..1"); v = String(n); }
  await runQuery(`INSERT INTO lotto_settings (key, value, updated, actor) VALUES (?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor`,
                 [key, v, clock(), actor ? String(actor).slice(0, 60) : null]);
  console.log(`[lotto] setting ${key} = ${v} by ${actor || "?"}`);
  const st = await loadSettings(true);
  if (key === "lotto_backend" && st.lotto_backend) { scheduleSnapshot(0); startTick(); }
  return st;
}

// ── small reads ──
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
function rowToDraw(r) {
  if (!r) return null;
  return Object.assign({}, r, { white: parse(r.white, null), plan: parse(r.plan, null), progress: parse(r.progress, {}) || {},
                                flags: parse(r.flags, {}) || {}, reseed: parse(r.reseed, null) });
}
async function draws(where, args) {
  return (await getQuery(`SELECT * FROM lotto_draws ${where || ""} ORDER BY draw`, args || [])).map(rowToDraw);
}
async function sellingDraw() {
  const r = await getQuery("SELECT * FROM lotto_draws WHERE state IN ('selling', 'closed') ORDER BY draw DESC LIMIT 1");
  return rowToDraw(r[0]);
}
async function saveDraw(D, fields) {
  const cols = Object.keys(fields);
  const vals = cols.map((c) => (["white", "plan", "progress", "flags", "reseed"].includes(c) && fields[c] !== null && typeof fields[c] === "object"
    ? JSON.stringify(fields[c]) : fields[c]));
  await runQuery(`UPDATE lotto_draws SET ${cols.map((c) => c + " = ?").join(", ")} WHERE draw = ?`, [...vals, D.draw]);
  Object.assign(D, fields);
}
async function potBalance() {
  await ensure();
  const r = await getQuery("SELECT COALESCE(SUM(amount), 0) AS t FROM lotto_pot");
  return (r[0] && r[0].t) || 0;
}
async function potHasRows() {
  await ensure();
  return (await getQuery("SELECT 1 FROM lotto_pot LIMIT 1")).length > 0;
}
const potDone = async (id) => (await getQuery("SELECT 1 FROM lotto_pot WHERE moveId = ?", [id])).length > 0;
async function potMove(id, draw, amount, why) {
  amount = Math.trunc(Number(amount) || 0);
  if (!amount || (await potDone(id))) return false;
  await runQuery("INSERT OR IGNORE INTO lotto_pot (moveId, draw, amount, why, created) VALUES (?, ?, ?, ?, ?)", [id, draw || null, amount, why || null, clock()]);
  return true;
}
const txDone = async (key) => (await getQuery("SELECT 1 FROM transactions WHERE transactionId = ?", [key])).length > 0;
const houseDone = async (key) => (await getQuery("SELECT 1 FROM jackpot_rakes WHERE jackpotId = ?", [key])).length > 0;
async function houseMove(key, spinId, userId, amount) {
  amount = Math.trunc(Number(amount) || 0);
  if (!amount || (await houseDone(key))) return false;
  await runQuery("INSERT OR IGNORE INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [key, spinId, userId || null, amount]);
  return true;
}
const jackpotOf = (pot) => Math.max(0, Math.min(Math.trunc(pot), E.RULES.JACKPOT_CAP));

// ── events ──
async function emit(kind, data) {
  const r = await runQuery("INSERT INTO lotto_events (ts, kind, data) VALUES (?, ?, ?)", [clock(), kind, JSON.stringify(data || {})]);
  if (r && r.id) S.lastSeq = Math.max(S.lastSeq, r.id);
  for (const w of Array.from(S.waiters)) { S.waiters.delete(w); w(); }
}

// ── draws ──
async function openDraw(draw, nextAt) {
  const seed = E.newServerSeed();
  const na = Math.trunc(nextAt);
  await runQuery(`INSERT OR IGNORE INTO lotto_draws (draw, state, next_at, close_at, commitment, server_seed, sold, flags, created)
                  VALUES (?, 'selling', ?, ?, ?, ?, 0, '{}', ?)`, [draw, na, na - E.RULES.CLOSE_SECS, E.commitment(seed), seed, clock()]);
  console.log(`[lotto] draw #${draw} open: draws ${new Date(na * 1000).toISOString()}, commitment ${E.commitment(seed).slice(0, 16)}...`);
  await emit("open", { draw, next_at: na, commitment: E.commitment(seed) });
}

async function ticketsOf(draw) {
  return (await getQuery("SELECT id, userId, name, w, pb FROM lotto_tickets WHERE draw = ? ORDER BY id", [draw]))
    .map((t) => ({ id: t.id, uid: t.userId, name: t.name, w: t.w.split(",").map(Number), pb: t.pb }));
}

async function closeSales(D) {
  if (D.state !== "selling") return;
  const tickets = await ticketsOf(D.draw);
  const digest = E.ticketsDigest(tickets);
  await saveDraw(D, { state: "closed", tickets_digest: digest, sold: tickets.length, closed_at: clock() });
  console.log(`[lotto] draw #${D.draw}: sales closed, ${tickets.length} tickets, digest ${digest.slice(0, 16)}...`);
  await emit("closed", { draw: D.draw, sold: tickets.length, tickets_digest: digest, next_at: D.next_at, jackpot: jackpotOf(await potBalance()) });
  scheduleSnapshot(0);
}

async function runDraw(D, forcedBy) {
  if (D.state === "selling") await closeSales(D);
  if (D.state !== "closed") return null;
  const tickets = await ticketsOf(D.draw);
  const { white, pb } = S.hooks.numbers ? S.hooks.numbers(D) : E.drawNumbers(D.server_seed, D.tickets_digest, D.draw);   // tests only
  const house = Math.max(0, await funding.jackpotPot());
  const pot = await potBalance();
  const p = E.plan({ tickets, white, pb, house, pot });
  const progress = {};
  await saveDraw(D, { state: "drawn", white, pb, plan: p, progress, house_at_draw: house, pot_at_draw: pot, drawn_at: clock(),
                      forced_by: forcedBy ? String(forcedBy).slice(0, 40) : null });
  const jpPaid = p.entries.filter((e) => e.reason === "lotto-jackpot").reduce((s, e) => s + e.amount, 0);
  const won = new Map();
  for (const e of p.entries) won.set(e.name, (won.get(e.name) || 0) + e.amount);
  const top = Array.from(won.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`[lotto] draw #${D.draw}: ${white.join(" ")} PB${pb} - ${tickets.length} tickets, ${p.winners} winning, paying ${fmt(p.paid)}`
              + `${p.jackpot_tickets ? `, JACKPOT ${fmt(p.jackpot)} x${p.jackpot_tickets}` : ""}${forcedBy ? ` (forced by ${forcedBy})` : ""}`);
  // the next draw opens now (Pepe: sales reopen right after the draw, while this one pays)
  const nextAt = E.nextDrawTs(Math.max(nowSec(), D.next_at) + 60);
  await openDraw(D.draw + 1, nextAt);
  await emit("drawn", { draw: D.draw, white, pb, tickets: tickets.length, winners: p.winners, paid: p.paid, jackpot: p.jackpot,
                        jackpot_winners: p.jackpot_tickets && p.jackpot ? p.jackpot_winners : [],
                        each: p.jackpot_tickets && p.jackpot ? Math.floor(p.jackpot / p.jackpot_tickets) : 0,
                        top: top.map(([n, a]) => [n, a]), next_at: nextAt, next_jackpot: jackpotOf(pot - jpPaid),
                        commitment: D.commitment, forced_by: forcedBy || null });
  scheduleSnapshot(0);
  return D;
}

async function flashCover(key, amount) {
  const prev = await getQuery("SELECT claimId FROM reserve_claims WHERE flow = 'flash:house:lotto' AND meta LIKE ?", [`%"ref":"${key}"%`]).catch(() => []);
  if (prev.length) return;
  await funding.houseFlashCover("lotto", amount, null, "lotto fixed prizes", key).catch((e) => console.error("[lotto] flash:", e.message));
}

/** Pay a drawn draw from its saved plan. Each step is keyed; the progress is saved before and after it. */
async function pay(D) {
  const p = D.plan;
  const prog = D.progress || {};
  const spin = `lotto:T${D.draw}`;
  const fixed = p.entries.filter((e) => e.reason !== "lotto-jackpot");
  const jps = p.entries.filter((e) => e.reason === "lotto-jackpot");
  // 1) the House pays the fixed prizes (Fed flash liquidity first; scaled down if it still can't)
  if (!prog.house && fixed.length) {
    const key = `${spin}:fixed`;
    if (prog.house_owed === undefined) {
      let owed = fixed.reduce((s, e) => s + e.amount, 0);
      if (owed > 0) await flashCover(key, owed);
      const have = Math.max(0, await funding.jackpotPot());
      if (owed > have && !(await houseDone(key))) {
        const k = owed ? have / owed : 0;
        for (const e of fixed) e.amount = Math.trunc(e.amount * k);
        p.scale = (p.scale || 1) * k;
        console.log(`[lotto] draw #${D.draw}: House ${fmt(have)} < owed ${fmt(owed)} - fixed prizes scaled by ${k.toFixed(3)}`);
        owed = fixed.reduce((s, e) => s + e.amount, 0);
      }
      prog.house_owed = owed;
      await saveDraw(D, { plan: p, progress: prog });
    }
    if (prog.house_owed > 0) await houseMove(key, spin, null, -prog.house_owed);
    prog.house = true;
    await saveDraw(D, { progress: prog });
  }
  if (S.hooks.crash) S.hooks.crash("after-house");
  // 2) the jackpot pot pays the jackpot
  if (!prog.pot && jps.length) {
    const key = `${spin}:jp`;
    if (prog.pot_owed === undefined) {
      let owed = jps.reduce((s, e) => s + e.amount, 0);
      const have = await potBalance();
      if (owed > have && !(await potDone(key))) {
        const k = owed ? have / owed : 0;
        for (const e of jps) e.amount = Math.trunc(e.amount * k);
        owed = jps.reduce((s, e) => s + e.amount, 0);
      }
      prog.pot_owed = owed;
      await saveDraw(D, { plan: p, progress: prog });
    }
    if (prog.pot_owed > 0) await potMove(key, D.draw, -prog.pot_owed, "lotto jackpot");
    prog.pot = true;
    await saveDraw(D, { progress: prog });
  }
  // 3) the players
  prog.unpaid = prog.unpaid || {};
  for (const e of p.entries) {
    if (!(e.amount > 0)) continue;
    const key = `${spin}:win:${e.uid}:${e.reason}`;
    if (prog.unpaid[key] || (await txDone(key))) continue;
    const r = await ledger.post(e.uid, e.amount, e.reason, { transactionId: key, resolveMerged: true, source: "lotto" });
    if (S.hooks.crash) S.hooks.crash("after-credit");
    if (!r.ok) {
      // the account is gone: the money goes back where it came from (keyed), the prize is recorded as unpaid
      console.warn(`[lotto] draw #${D.draw}: ${e.reason} ${e.amount} for ${e.uid} not paid (${r.code}) - returned`);
      if (e.reason === "lotto-jackpot") await potMove(`${key}:return`, D.draw, e.amount, "unpaid jackpot returned");
      else await houseMove(`${key}:return`, spin, null, e.amount);
      prog.unpaid[key] = r.code || "failed";
      await saveDraw(D, { progress: prog });
    }
  }
  // 4) XP (Pepe's _grant_xp rate) + the website notice - once per player (marked BEFORE: never twice)
  const per = new Map();
  for (const e of p.entries) {
    if (prog.unpaid[`${spin}:win:${e.uid}:${e.reason}`]) continue;
    const x = per.get(e.uid) || { uid: e.uid, name: e.name, amount: 0, wins: 0, jackpot: 0 };
    x.amount += e.amount; x.wins += e.tickets;
    if (e.reason === "lotto-jackpot") x.jackpot += e.tickets;
    per.set(e.uid, x);
  }
  prog.notified = prog.notified || {};
  for (const x of per.values()) {
    if (prog.notified[x.uid] || !(x.amount > 0)) continue;
    prog.notified[x.uid] = 1;
    await saveDraw(D, { progress: prog });
    try {
      const xp = Math.round(x.amount * 0.005);
      const up = S.hooks.updateLevel || require("../user.controller").updateLevel;
      if (xp > 0 && up) await up(x.uid, xp);
    } catch (e) { console.error("[lotto] xp:", e.message); }
    try {
      await require("../inbox").addSafe(x.uid, { kind: "lotto", title: `Lotto draw #${D.draw}: you won PAT ${fmt(x.amount)}`,
        body: `🎟️ Your lotto ticket(s) won PAT ${fmt(x.amount)} in draw #${D.draw}! It's in your balance.`, link: "/lotto",
        ref: `lotto:${D.draw}:${x.uid}` });
    } catch (e) { /* a notice never blocks a payout */ }
  }
  // 5) history (Pepe's shape) + done
  const paidEntries = p.entries.filter((e) => !prog.unpaid[`${spin}:win:${e.uid}:${e.reason}`]);
  const byName = new Map();
  for (const e of paidEntries) byName.set(e.name, (byName.get(e.name) || 0) + e.amount);
  const hist = { draw: D.draw, white: D.white, pb: D.pb, tickets: D.sold, winners: p.winners,
                 paid: Array.from(byName.values()).reduce((s, a) => s + a, 0), jackpot: p.jackpot,
                 jackpot_winners: p.jackpot_tickets && p.jackpot ? p.jackpot_winners : [],
                 jackpot_paid: jps.reduce((s, e) => s + e.amount, 0),
                 won: Array.from(byName.entries()).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([n, a]) => [n, a]),
                 ts: Math.floor((D.drawn_at || clock()) / 1000), commitment: D.commitment, tickets_digest: D.tickets_digest };
  await runQuery("INSERT OR REPLACE INTO lotto_history (draw, data) VALUES (?, ?)", [D.draw, JSON.stringify(hist)]);
  const jpHit = jps.some((e) => e.amount > 0);
  await saveDraw(D, { state: "paid", paid_at: clock(), reseed: jpHit ? { state: "due", want: E.RULES.POT_RESEED } : null });
  const users = await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE userId IN (${Array.from(per.keys()).map(() => "?").join(",") || "''"})`,
                               Array.from(per.keys())).catch(() => []);
  const U = new Map(users.map((u) => [u.userId, u]));
  await emit("paid", { draw: D.draw, paid: hist.paid, winners: Array.from(per.values()).map((x) => ({
    name: x.name, camfrog: (U.get(x.uid) || {}).camfrogUsername || null, username: (U.get(x.uid) || {}).username || null,
    amount: x.amount, wins: x.wins, jackpot: x.jackpot })), reseed_due: jpHit });
  console.log(`[lotto] draw #${D.draw} paid: ${fmt(hist.paid)} to ${per.size} player(s)`);
  scheduleSnapshot(0);
}

// ── the tick ──
async function tickOnce() {
  const st = await loadSettings();
  if (!st.lotto_backend) { S.wasOn = false; return; }
  if (!S.wasOn) { S.wasOn = true; scheduleSnapshot(0); }
  const all = await draws("WHERE state != 'paid'");
  if (!(await getQuery("SELECT 1 FROM lotto_draws LIMIT 1")).length) {
    await openDraw(1, E.nextDrawTs(nowSec()));          // a fresh database (no import): draw #1
    return;
  }
  if (!all.some((d) => d.state === "selling" || d.state === "closed")) {
    const last = (await getQuery("SELECT MAX(draw) AS d, MAX(next_at) AS n FROM lotto_draws"))[0];
    await openDraw(last.d + 1, E.nextDrawTs(Math.max(nowSec(), last.n) + 60));    // a crash between draw and reopen
  }
  for (const D of all) {
    const t = nowSec();
    if (D.state === "selling") {
      if (!D.flags.closing && t >= D.close_at - E.RULES.CLOSING_SECS && t < D.close_at) {
        D.flags.closing = 1;
        await saveDraw(D, { flags: D.flags });
        await emit("closing", { draw: D.draw, close_at: D.close_at, next_at: D.next_at, sold: D.sold, jackpot: jackpotOf(await potBalance()) });
      }
      if (t >= D.close_at) await closeSales(D);
    }
    if (D.state === "closed" && t >= D.next_at) await runDraw(D, null);
    if (D.state === "drawn") {
      const wait = S.payBackoff.get(D.draw) || 0;
      if (clock() >= wait) {
        try { await pay(D); S.payBackoff.delete(D.draw); }
        catch (e) { console.error(`[lotto] draw #${D.draw} pay:`, e.message); S.payBackoff.set(D.draw, clock() + 30000); }
      }
    }
  }
}
function startTick() {
  if (S.tick) return;
  S.tick = setInterval(() => locked(tickOnce).catch((e) => console.error("[lotto] tick:", e.message)), 5000);
  if (S.tick.unref) S.tick.unref();
}

// ── recovery ──
async function recover() {
  // a purchase a crash caught between its charge and its tickets: finish it (sales still open) or refund it
  for (const pu of await getQuery("SELECT * FROM lotto_purchases WHERE state = 'charging'")) {
    if (!(await txDone(pu.key))) {
      await runQuery("UPDATE lotto_purchases SET state = 'failed' WHERE key = ?", [pu.key]);
      continue;
    }
    const D = rowToDraw((await getQuery("SELECT * FROM lotto_draws WHERE draw = ?", [pu.draw]))[0]);
    if (D && D.state === "selling" && nowSec() < D.close_at) await finishPurchase(pu);
    else await refundPurchase(pu, "lotto-late-refund");
  }
}
async function boot(opts) {
  if (S.booted) return S.booted;
  S.booted = (async () => {
    await ensure();
    await runQuery("DELETE FROM lotto_events WHERE ts < ?", [clock() - 30 * 86400 * 1000]).catch(() => {});
    await locked(recover);
    const st = await loadSettings(true);
    // always (tests: {tick: false}): it idles while lotto_backend is off (a CLI / another process can flip it)
    if (!opts || opts.tick !== false) startTick();
    if (st.lotto_backend) scheduleSnapshot(0);
  })().catch((e) => { S.booted = null; throw e; });
  return S.booted;
}

// ── purchases ──
async function finishPurchase(pu) {
  const picks = parse(pu.picks, []);
  const have = (await getQuery("SELECT COUNT(*) AS n FROM lotto_tickets WHERE purchase = ?", [pu.key]))[0].n;
  if (!have && picks.length) {
    const ts = clock();
    const rows = picks.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const vals = [];
    for (const [w, pb] of picks) vals.push(pu.draw, pu.userId, pu.name, w.join(","), pb, pu.key, ts);
    await runQuery(`INSERT INTO lotto_tickets (draw, userId, name, w, pb, purchase, created) VALUES ${rows}`, vals);   // one statement
  }
  const potAmt = Math.trunc(Number(pu.pot) || 0);
  await potMove(`${pu.key}:pot`, pu.draw, potAmt, "lotto tickets (pot share)");
  await houseMove(`${pu.key}:house`, `lotto:T${pu.draw}`, pu.userId, pu.cost - potAmt);
  const sold = (await getQuery("SELECT COUNT(*) AS n FROM lotto_tickets WHERE draw = ?", [pu.draw]))[0].n;
  await runQuery("UPDATE lotto_draws SET sold = ? WHERE draw = ?", [sold, pu.draw]);
  await runQuery("UPDATE lotto_purchases SET state = 'done' WHERE key = ?", [pu.key]);
  return sold;
}
async function refundPurchase(pu, why) {
  await ledger.post(pu.userId, pu.cost, why, { transactionId: `${pu.key}:refund`, resolveMerged: true, source: "lotto" });
  await runQuery("UPDATE lotto_purchases SET state = 'refunded' WHERE key = ?", [pu.key]);
  console.log(`[lotto] purchase ${pu.key} refunded (${why})`);
}

async function userRow(uid) {
  return (await getQuery("SELECT userId, username, displayname, camfrogUsername, casino_banned, class, points_balance FROM users WHERE userId = ?", [uid]))[0] || null;
}
async function mineCount(draw, uid) {
  return (await getQuery("SELECT COUNT(*) AS n FROM lotto_tickets WHERE draw = ? AND userId = ?", [draw, uid]))[0].n;
}

/**
 * Buy tickets. actor {uid, name, via}; picks = [[w[4], pb]] or null with quick = n. key = the idempotency key
 * (one charge per key, ever). -> {ok, code, bought, count, cost, mine, jackpot, draw, next_at, balance?}
 */
function buy(actor, { picks, quick }, key) {
  return locked(async () => {
    await ensure();
    const st = await loadSettings();
    const done = (await getQuery("SELECT response, state FROM lotto_purchases WHERE key = ?", [key]))[0];
    if (done && done.response) return Object.assign(parse(done.response, {}), { replay: true });
    if (!st.lotto_backend) return { ok: false, code: "off" };
    const u = await userRow(actor.uid);
    if (!u) return { ok: false, code: "no_account" };
    if (u.casino_banned) return { ok: false, code: "banned" };
    const D = await sellingDraw();
    if (!D || D.state !== "selling" || nowSec() >= D.close_at) return { ok: false, code: "closed", next_at: D ? D.next_at : null };
    let list;
    if (picks && picks.length) {
      list = picks.slice(0, E.RULES.MAX_PER_BUY).map(([w, pb]) => [w.map(Number).sort((a, b) => a - b), Number(pb)]);
      if (!list.every(([w, pb]) => E.validPick(w, pb))) return { ok: false, code: "bad_pick" };
    } else {
      const n = Math.max(1, Math.min(Math.trunc(Number(quick) || 1), E.RULES.MAX_PER_BUY));
      list = Array.from({ length: n }, () => E.quickPick());
    }
    const cost = list.length * st.price;
    const pot = Math.trunc(cost * st.pot_share);
    const name = String(actor.name || u.camfrogUsername || u.displayname || u.username).replace(/[\u0000-\u001f]/g, " ").slice(0, 40);
    await runQuery(`INSERT INTO lotto_purchases (key, draw, userId, name, picks, count, cost, pot, state, via, created)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'charging', ?, ?)`, [key, D.draw, u.userId, name, JSON.stringify(list), list.length, cost, pot,
                    String(actor.via || "web").slice(0, 20), clock()]);
    const r = await ledger.post(u.userId, -cost, "lotto-tickets", { transactionId: key, requireCover: true, source: "lotto" });
    if (!r.ok) {
      const out = { ok: false, code: r.code === ledger.E_INSUFFICIENT ? "insufficient" : "charge_failed", cost, balance: u.points_balance };
      await runQuery("UPDATE lotto_purchases SET state = 'failed', response = ? WHERE key = ?", [JSON.stringify(out), key]);
      return out;
    }
    const before = D.sold || 0;
    const sold = await finishPurchase({ key, draw: D.draw, userId: u.userId, name, picks: JSON.stringify(list), cost, pot });
    const potNow = await potBalance();
    const out = { ok: true, bought: list.length <= 5 ? list : [], count: list.length, cost, mine: await mineCount(D.draw, u.userId),
                  jackpot: jackpotOf(potNow), draw: D.draw, next_at: D.next_at };
    await runQuery("UPDATE lotto_purchases SET response = ? WHERE key = ?", [JSON.stringify(out), key]);
    await emit("sale", { draw: D.draw, count: list.length, sold, uid: u.userId, username: u.username, camfrog: u.camfrogUsername || null,
                         via: actor.via || "web" });
    const M = E.RULES.MILESTONE;
    if (Math.floor(sold / M) > Math.floor(before / M)) {
      await emit("milestone", { draw: D.draw, sold: Math.floor(sold / M) * M, jackpot: jackpotOf(potNow), next_at: D.next_at });
    }
    scheduleSnapshot(1500);
    return out;
  });
}

// ── reads for clients ──
async function info(uid) {
  await boot();
  const st = await loadSettings();
  const D = await sellingDraw();
  const pot = await potBalance();
  return { enabled: st.lotto_backend, draw: D ? D.draw : null, next_at: D ? D.next_at : null, close_at: D ? D.close_at : null,
           sales_open: !!(D && D.state === "selling" && nowSec() < D.close_at), price: st.price, jackpot: jackpotOf(pot), pot,
           sold: D ? D.sold : 0, commitment: D ? D.commitment : null, mine: uid && D ? await mineCount(D.draw, uid) : 0 };
}
async function myTickets(uid) {
  const D = await sellingDraw();
  if (!D) return { draw: null, tickets: [] };
  const t = await getQuery("SELECT w, pb FROM lotto_tickets WHERE draw = ? AND userId = ? ORDER BY id", [D.draw, uid]);
  return { draw: D.draw, next_at: D.next_at, tickets: t.map((x) => [x.w.split(",").map(Number), x.pb]) };
}
async function history(limit = 52) {
  await ensure();
  return (await getQuery("SELECT data FROM lotto_history ORDER BY draw DESC LIMIT ?", [limit])).map((r) => parse(r.data, null)).filter(Boolean);
}

// ── the page's snapshot (lotto_state; lotto.js storeSnapshot) ──
async function snapshot() {
  const st = await loadSettings();
  const D = await sellingDraw();
  const pot = await potBalance();
  const players = {};
  if (D) {
    const rows = await getQuery(`SELECT t.userId, t.w, t.pb, u.username, u.camfrogUsername FROM lotto_tickets t LEFT JOIN users u ON u.userId = t.userId
                                 WHERE t.draw = ? ORDER BY t.id`, [D.draw]);
    for (const r of rows) {
      const k = (r.camfrogUsername ? String(r.camfrogUsername) : "@" + String(r.username || r.userId)).toLowerCase();
      const p = players[k] || (players[k] = { count: 0, tickets: [] });
      p.count++;
      if (p.tickets.length < 300) p.tickets.push([r.w.split(",").map(Number), r.pb]);
    }
  }
  return { draw: D ? D.draw : 0, next_at: D ? D.next_at : 0, sales_open: !!(D && D.state === "selling" && nowSec() < D.close_at),
           price: st.price, close_secs: E.RULES.CLOSE_SECS, jackpot: jackpotOf(pot), sold: D ? D.sold : 0,
           prizes: E.PRIZE_ORDER.map(([w, b]) => [w, b, E.PRIZES[E.tierKey(w, b)]]), players, history: await history(52),
           backend: true, commitment: D ? D.commitment : null };
}
function scheduleSnapshot(delay) {
  if (S.snapTimer) return;
  S.snapTimer = setTimeout(async () => {
    S.snapTimer = null;
    try {
      const st = await loadSettings();
      if (!st.lotto_backend) return;
      await require("../lotto").storeSnapshot(await snapshot());
    } catch (e) { console.error("[lotto] snapshot:", e.message); }
  }, Math.max(0, delay || 0));
  if (S.snapTimer.unref) S.snapTimer.unref();
}

// ── Pepe ──
async function poll(after, waitMs) {
  await boot();
  const st = await loadSettings();
  const reseed = (await draws("WHERE state = 'paid' AND reseed IS NOT NULL")).filter((d) => d.reseed && d.reseed.state === "due")
    .map((d) => ({ draw: d.draw, want: d.reseed.want }));
  const base = { enabled: st.lotto_backend, reseed, state: await info(null) };
  if (Number(after) < 0 || Number(after) > S.lastSeq) return Object.assign(base, { cursor: S.lastSeq, events: [] });
  after = Math.max(0, Math.trunc(Number(after) || 0));
  const read = () => getQuery("SELECT seq, ts, kind, data FROM lotto_events WHERE seq > ? ORDER BY seq LIMIT 200", [after]);
  let rows = await read();
  if (!rows.length && waitMs > 0) {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(tm); S.waiters.delete(done); resolve(); };
      const tm = setTimeout(done, waitMs);
      S.waiters.add(done);
    });
    rows = await read();
  }
  const events = rows.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, data: parse(r.data, {}) }));
  return Object.assign(base, { cursor: events.length ? events[events.length - 1].seq : Math.max(after, S.lastSeq), events });
}

/** Pepe moves PAT into (+) or out of (-) the pot: !donate lotto, a Fed grant, the reseed. Keyed by his ref. */
function botPot(amount, ref, why) {
  return locked(async () => {
    await ensure();
    amount = Math.trunc(Number(amount) || 0);
    const id = `bot:${String(ref).slice(0, 100)}`;
    if (!amount) return { ok: true, none: true, pot: await potBalance() };
    if (await potDone(id)) return { ok: true, replay: true, pot: await potBalance() };
    const pot = await potBalance();
    if (amount < 0 && pot < -amount) return { ok: false, code: "short", pot };
    const D = await sellingDraw();
    await potMove(id, D ? D.draw : null, amount, why ? String(why).slice(0, 80) : "pepe");
    scheduleSnapshot(1500);
    return { ok: true, pot: pot + amount };
  });
}
function botReseeded(draw, amount) {
  return locked(async () => {
    const D = rowToDraw((await getQuery("SELECT * FROM lotto_draws WHERE draw = ?", [Math.trunc(Number(draw) || 0)]))[0]);
    if (!D || !D.reseed) return { ok: false };
    await saveDraw(D, { reseed: Object.assign({}, D.reseed, { state: "done", amount: Math.trunc(Number(amount) || 0), at: clock() }) });
    return { ok: true };
  });
}
/** An admin's forced draw (Pepe's !lotto draw): close the sales now and draw. */
function forceDraw(by) {
  return locked(async () => {
    const st = await loadSettings();
    if (!st.lotto_backend) return { ok: false, code: "off" };
    const D = await sellingDraw();
    if (!D) return { ok: false, code: "none" };
    if ((await getQuery("SELECT 1 FROM lotto_draws WHERE state = 'drawn'")).length) return { ok: false, code: "paying" };
    await runDraw(D, by || "admin");
    const d2 = rowToDraw((await getQuery("SELECT * FROM lotto_draws WHERE draw = ?", [D.draw]))[0]);
    try { await pay(d2); } catch (e) { console.error("[lotto] forced pay:", e.message); }
    return { ok: true, draw: D.draw };
  });
}

// ── fairness ──
async function fairRecord(draw) {
  await ensure();
  const D = rowToDraw((await getQuery("SELECT * FROM lotto_draws WHERE draw = ?", [Math.trunc(Number(draw) || 0)]))[0]);
  if (!D) return null;
  const revealed = D.state === "drawn" || D.state === "paid";
  const out = { draw: D.draw, state: D.state, commitment: D.commitment, tickets_digest: D.tickets_digest || null,
                server_seed: revealed ? D.server_seed : null, white: revealed ? D.white : null, pb: revealed ? D.pb : null,
                imported: !!(D.flags && D.flags.imported) };
  if (D.tickets_digest) {
    out.tickets = (await getQuery("SELECT id, w, pb FROM lotto_tickets WHERE draw = ? ORDER BY id", [D.draw]))
      .map((t) => [t.id, t.w.split(",").map(Number), t.pb]);
  }
  return out;
}

// ── the cutover: Pepe's state in (import) and out (export) ──
async function totals(draw) {
  const rows = await getQuery(`SELECT u.username, COUNT(*) AS n FROM lotto_tickets t LEFT JOIN users u ON u.userId = t.userId
                               WHERE t.draw = ? GROUP BY t.userId ORDER BY u.username`, [draw]);
  const per = {};
  for (const r of rows) per[String(r.username || "?").toLowerCase()] = r.n;
  return { tickets: rows.reduce((s, r) => s + r.n, 0), players: rows.length, per_user: per, pot: await potBalance(),
           history: (await getQuery("SELECT COUNT(*) AS n FROM lotto_history"))[0].n };
}
const sameTotals = (a, b) => a.tickets === b.tickets && a.pot === b.pot && a.history === b.history && a.players === b.players
  && JSON.stringify(Object.entries(a.per_user).sort()) === JSON.stringify(Object.entries(b.per_user).sort());

/**
 * Pepe's export (camfrog-bot pepe_lotto._lotto_export) -> this database. Only into an EMPTY lotto (no draws, no pot) unless
 * it is the same key again (then the stored result). Everything is verified against the export's own totals; a mismatch
 * removes what was written and changes nothing else. enable = turn lotto_backend on when it matches.
 */
function importState(x, key, { enable = false, actor = null } = {}) {
  return locked(async () => {
    await ensure();
    key = String(key || "").slice(0, 80);
    if (!key) return { ok: false, error: "key required" };
    const prev = (await getQuery("SELECT result FROM lotto_imports WHERE key = ?", [key]))[0];
    if (prev) return Object.assign(parse(prev.result, {}), { replay: true });
    if ((await getQuery("SELECT 1 FROM lotto_draws LIMIT 1")).length || (await potHasRows()))
      return { ok: false, error: "the backend lotto isn't empty - nothing imported (reset it first on staging)" };
    if (!x || x.v !== 1 || !(x.draw > 0) || !(x.next_at > 0) || !Array.isArray(x.tickets) || !x.totals) return { ok: false, error: "bad export" };
    if (x.pending_draw) return { ok: false, error: "the export has a draw still paying - wait for it" };
    // accounts
    const names = Array.from(new Set(x.tickets.map((t) => String(t.user || "").toLowerCase())));
    const umap = new Map();
    for (let i = 0; i < names.length; i += 400) {
      const chunk = names.slice(i, i + 400);
      const rows = await getQuery(`SELECT userId, username FROM users WHERE LOWER(username) IN (${chunk.map(() => "?").join(",")})`, chunk);
      for (const r of rows) umap.set(String(r.username).toLowerCase(), r.userId);
    }
    const missing = names.filter((n) => !umap.has(n));
    if (missing.length) return { ok: false, error: `${missing.length} ticket owner(s) have no PATV account`, missing: missing.slice(0, 20) };
    for (const t of x.tickets) if (!E.validPick(t.w, t.pb)) return { ok: false, error: "a ticket with bad numbers", ticket: t };
    const price = Math.trunc(Number(x.price) || E.RULES.PRICE);
    const share = Number.isFinite(Number(x.pot_share)) ? Number(x.pot_share) : E.RULES.POT_SHARE;
    // write
    const seed = E.newServerSeed();
    const draw = Math.trunc(x.draw), nextAt = Math.trunc(x.next_at);
    await runQuery(`INSERT INTO lotto_draws (draw, state, next_at, close_at, commitment, server_seed, sold, flags, created)
                    VALUES (?, 'selling', ?, ?, ?, ?, ?, ?, ?)`, [draw, nextAt, nextAt - E.RULES.CLOSE_SECS, E.commitment(seed), seed,
                    x.tickets.length, JSON.stringify({ imported: key }), clock()]);
    const ts = clock();
    for (let i = 0; i < x.tickets.length; i += 200) {
      const chunk = x.tickets.slice(i, i + 200);
      const vals = [];
      for (const t of chunk) vals.push(draw, umap.get(String(t.user).toLowerCase()), String(t.who || t.user).slice(0, 40),
                                       t.w.slice().sort((a, b) => a - b).join(","), t.pb, `import:${key}`, ts);
      await runQuery(`INSERT INTO lotto_tickets (draw, userId, name, w, pb, purchase, created) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`, vals);
    }
    if (Math.trunc(x.pot) > 0) await potMove(`import:${key}`, draw, Math.trunc(x.pot), "cutover: the pot Pepe held");
    for (const h of (x.history || []).slice(0, 60)) {
      if (h && h.draw > 0) await runQuery("INSERT OR REPLACE INTO lotto_history (draw, data) VALUES (?, ?)", [Math.trunc(h.draw), JSON.stringify(h)]);
    }
    const got = await totals(draw);
    const want = { tickets: Math.trunc(x.totals.tickets), players: Math.trunc(x.totals.players), pot: Math.trunc(x.totals.pot),
                   history: Math.min(60, Math.trunc(x.totals.history)), per_user: Object.fromEntries(Object.entries(x.totals.per_user || {}).map(([k, v]) => [k.toLowerCase(), v])) };
    const match = sameTotals(got, want);
    if (!match) {
      // undo: the backend was empty, so everything in it is this import
      await runQuery("DELETE FROM lotto_tickets"); await runQuery("DELETE FROM lotto_draws"); await runQuery("DELETE FROM lotto_pot");
      await runQuery("DELETE FROM lotto_history");
      console.error(`[lotto] import ${key}: totals MISMATCH - undone`, JSON.stringify({ got: Object.assign({}, got, { per_user: undefined }), want: Object.assign({}, want, { per_user: undefined }) }));
      return { ok: false, error: "totals mismatch - nothing kept", got, want };
    }
    await runQuery(`INSERT INTO lotto_settings (key, value, updated, actor) VALUES ('price', ?, ?, ?), ('pot_share', ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor`,
                   [String(price), clock(), actor || "import", String(share), clock(), actor || "import"]);
    const result = { ok: true, key, draw, next_at: nextAt, totals: got, price, pot_share: share, commitment: E.commitment(seed), enabled: false };
    if (enable) { await runQuery(`INSERT INTO lotto_settings (key, value, updated, actor) VALUES ('lotto_backend', '1', ?, ?)
                                  ON CONFLICT(key) DO UPDATE SET value = '1', updated = excluded.updated, actor = excluded.actor`, [clock(), actor || "import"]);
                  result.enabled = true; }
    await runQuery("INSERT INTO lotto_imports (key, result, created) VALUES (?, ?, ?)", [key, JSON.stringify(result), clock()]);
    await loadSettings(true);
    console.log(`[lotto] imported Pepe's lotto (${key}): draw #${draw}, ${got.tickets} tickets / ${got.players} players, pot ${fmt(got.pot)}, `
                + `${got.history} past draws; backend ${result.enabled ? "ON" : "still off"}`);
    if (result.enabled) { startTick(); scheduleSnapshot(0); }
    return result;
  });
}

/** The backend's state in Pepe's export shape (the rollback runs it back into Pepe). Only between draws. */
function exportState() {
  return locked(async () => {
    await ensure();
    const D = await sellingDraw();
    if (!D) return { ok: false, error: "no draw selling" };
    if ((await getQuery("SELECT 1 FROM lotto_draws WHERE state = 'drawn'")).length) return { ok: false, error: "a draw is still paying" };
    if ((await getQuery("SELECT 1 FROM lotto_purchases WHERE state = 'charging'")).length) return { ok: false, error: "a purchase is in flight" };
    const rows = await getQuery(`SELECT t.name, t.w, t.pb, u.username FROM lotto_tickets t LEFT JOIN users u ON u.userId = t.userId
                                 WHERE t.draw = ? ORDER BY t.id`, [D.draw]);
    const st = await loadSettings();
    const tickets = rows.map((r) => ({ user: r.username, who: r.name, w: r.w.split(",").map(Number), pb: r.pb }));
    const t = await totals(D.draw);
    return { ok: true, v: 1, source: "site", draw: D.draw, next_at: D.next_at, price: st.price, pot_share: st.pot_share, pot: t.pot,
             tickets, history: await history(60), pending_draw: null, totals: t, state: D.state };
  });
}

/** STAGING / tests only: wipe the backend lotto (refused while it holds a pot or tickets unless forced in staging). */
async function resetAll() {
  return locked(async () => {
    await ensure();
    for (const t of ["lotto_tickets", "lotto_draws", "lotto_pot", "lotto_history", "lotto_purchases", "lotto_imports", "lotto_events"]) await runQuery(`DELETE FROM ${t}`);
    await runQuery("DELETE FROM lotto_settings WHERE key = 'lotto_backend'");
    await loadSettings(true);
    return { ok: true };
  });
}

/** Tests: forget the boot (a "restart"), stop the tick. */
function stop() {
  if (S.tick) clearInterval(S.tick);
  if (S.snapTimer) clearTimeout(S.snapTimer);
  S.tick = null; S.snapTimer = null; S.booted = null; S.settings = null; S.wasOn = false;
}

function ipRateOk(uid) {
  const now = clock(), a = (S.rate.get(uid) || []).filter((t) => now - t < 10000);
  a.push(now); S.rate.set(uid, a);
  return a.length <= 8;
}

module.exports = { boot, ensure, loadSettings, setSetting, buy, info, myTickets, history, snapshot, poll, botPot, botReseeded, forceDraw,
                   fairRecord, importState, exportState, resetAll, potBalance, potHasRows, tickOnce, ipRateOk, totals, stop, recover: () => locked(recover),
                   tick: () => locked(tickOnce),
                   _S: S, _locked: locked, _pay: pay, _draws: draws };
