// challengepay.js — mic challenge prizes paid out of a pad's ROOM-VAULT ESCROW (camfrog-bot pepe_challenge.py).
//
// The escrow: boosts, stage slot fees and pad-cosmetic gifts put their room half into room_flow_ledger
// (boosts.js routeInTx) and it is HELD there for the pad until economy v2 E-3 opens real room vaults. Until
// this module nothing ever paid out of it. Pepe's mic challenges are the first (approved) payout:
//
//   POST /api/rooms/:room/challenge/payout   (bot token) {ref, userId, login, amount, min, pct, cap, cat, score}
//     * :room is the Camfrog room id (rooms_registry) - the escrow is that pad's and nobody else's: this never
//       touches the Federal Reserve, Fort Knox, or another pad's escrow
//     * balance  = SUM(room_vault) of the room's rows not yet migrated (migrated_rv IS NULL) - payouts included,
//                  since a payout row's room_vault is negative
//     * 24 h cap = min(cap, pct% of (balance + what was paid in the last 24 h)) - so a room can lose at most
//                  pct% of its escrow a day (5% default: the escrow can't be drained, it decays at worst ~5%/day);
//                  pct / cap are Pepe's settings, clamped to this site's ceilings (pct_max, cap_max, payout_max)
//     * pays min(amount, payout_max, what's left of the cap, balance): never below zero, never more than asked;
//       nothing at all when that is under `min` (Pepe's smallest prize) - the challenge is then "for glory"
//     * ONE transaction (mainstage's tx: BEGIN IMMEDIATE, serialized): the room_flow_ledger row (kind
//       "challenge", amount = fortknox + room_vault = -paid, payer_id / payer_name = the WINNER) and the credit
//       through ledger.postOrThrow (the account must exist; a merged-away id is followed). A failure rolls both back.
//     * idempotent: the row's ref is "challenge:<Pepe's ref>" (unique). The same ref again returns the first
//       result with dup = true and pays nothing.
//     -> {ok:true, paid, balance, left} | {ok:false, code: no_room|off|empty|cap|no_account|bad, paid:0}
//   POST /api/rooms/:room/challenge/vault    (bot token) {pct, cap} -> {ok, balance, paid24, cap, left, pct}
//   POST /api/rooms/:room/challenge/fee      (bot token) {ref, amount, a, b}
//     The fee of a staked head-to-head (5% of the pot by default). The stakes already left both wallets through
//     Pepe's escrow (wager charge); the winner got pot - fee back. The fee is booked EXACTLY like a boost:
//     boosts.routeInTx, kind "challenge_fee", flow "challenge_fee": Fort Knox half (ceil) as a negative
//     reserve_claims row (Pepe credits Fort Knox when econ_layers is on - "fortknox:challenge_fee" - else his
//     Reserve as its stand-in), room half (floor) held in this pad's escrow. When the room's owner is one of the
//     two performers (or the room has no pad) it is all Fort Knox (doc 7.1: self-spend never feeds your own
//     vault). Idempotent by "chalfee:<ref>".
//   GET/POST /api/challenge/admin (site staff): {on, pct, cap, pct_max, cap_max, payout_max} + every room's escrow.
//
// E-3 (camfrog-bot docs/ECONOMY-V2.md, branch economy-v2-doc): kind "challenge" rows are room-vault OUTFLOWS
// already paid. E-3 migrates each room's NET remaining balance - SUM(room_vault) WHERE migrated_rv IS NULL,
// which already subtracts every challenge payout - into room:<id>, and stamps migrated_rv on every row it
// counted, payouts included. Nothing is paid twice and nothing paid out is migrated.
//
// E-3 AS BUILT (section 9 "At E-3": the payout endpoint debits room:<id> instead of the escrow, same caps, same refs):
// while Pepe's room vaults are live he sends vault = "room" and the vault's balance (it lives in Pepe). The budget is
// then computed on that balance (the 24 h paid figure still counts every challenge row of the room, escrow-paid ones
// included), the row is written with rv_to = 'room' (so the escrow sum ignores it) and Pepe debits room:<id> by `paid`
// once per ref after the answer (the answer echoes vault). While room vaults are live an ESCROW-mode prize is refused
// (code "moved"): the escrow is being / has been migrated into the vault, so paying from it could pay twice.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const DEFAULTS = Object.freeze({
  on: true,             // switch: off = every payout answers "off" (the challenge runs for glory)
  pct: 5,               // default % of the room's escrow prizes may take per 24 h (Pepe sends his own)
  cap: 60000,           // default absolute PAT per room per 24 h
  pct_max: 10,          // ceilings: whatever Pepe asks for is clamped to these
  cap_max: 150000,
  payout_max: 25000,    // one prize, at most (Pepe's max is 20,000 = 10/10 x 2,000)
});
const DAY = 24 * 3600 * 1000;
const REF_RE = /^[A-Za-z0-9_.:-]{3,80}$/;

let clock = () => Date.now();
const now = () => clock();

let ready = null;
let CONFIG = { ...DEFAULTS };
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./boosts").init();                 // room_flow_ledger + reserve_claims
      await runQuery("CREATE TABLE IF NOT EXISTS challenge_pay_config (key TEXT PRIMARY KEY, value TEXT)");
      const c = { ...DEFAULTS };
      for (const r of await getQuery("SELECT key, value FROM challenge_pay_config")) {
        try { if (r.key in DEFAULTS) c[r.key] = JSON.parse(r.value); } catch (e) { /* skip */ }
      }
      CONFIG = cleanConfig(c);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
function cleanConfig(c) {
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const on = (v, d) => (v === undefined || v === null || v === "" ? d : v === true || v === "true" || v === 1 || v === "1" || v === "on");
  const o = {
    on: on(c.on, DEFAULTS.on),
    pct_max: num(c.pct_max, 0, 50, DEFAULTS.pct_max),
    cap_max: Math.floor(num(c.cap_max, 0, 10000000, DEFAULTS.cap_max)),
    payout_max: Math.floor(num(c.payout_max, 0, 10000000, DEFAULTS.payout_max)),
  };
  o.pct = num(c.pct, 0, o.pct_max, Math.min(DEFAULTS.pct, o.pct_max));
  o.cap = Math.floor(num(c.cap, 0, o.cap_max, Math.min(DEFAULTS.cap, o.cap_max)));
  return o;
}
async function setConfig(patch) {
  await init();
  const next = cleanConfig({ ...CONFIG, ...(patch || {}) });
  for (const k of Object.keys(DEFAULTS)) {
    await runQuery("INSERT INTO challenge_pay_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                   [k, JSON.stringify(next[k])]);
  }
  CONFIG = next;
  return { ...CONFIG };
}
const config = () => ({ ...CONFIG });

class Refuse extends Error {
  constructor(code, message) { super(message || code); this.code = code; this.refuse = true; }
}

/** The room's escrow and today's prize budget. Call inside the tx when it decides a payout. */
async function budget(roomId, opts = {}) {
  const C = CONFIG;
  const roomMode = opts.vault === "room";
  const pct = Math.min(C.pct_max, Math.max(0, Number.isFinite(Number(opts.pct)) && opts.pct !== null && opts.pct !== undefined ? Number(opts.pct) : C.pct));
  const cap = Math.min(C.cap_max, Math.max(0, Number.isFinite(Number(opts.cap)) && opts.cap !== null && opts.cap !== undefined ? Math.floor(Number(opts.cap)) : C.cap));
  // E-3: the room vault's balance comes from Pepe (room:<id>); else this pad's escrow (unmigrated rows held here)
  const r = roomMode ? { bal: Math.max(0, Math.floor(Number(opts.balance) || 0)) }
    : (await getQuery(`SELECT COALESCE(SUM(room_vault), 0) AS bal FROM room_flow_ledger WHERE room_id = ? AND migrated_rv IS NULL AND rv_to IS NULL`, [roomId]))[0];
  const p = (await getQuery(`SELECT COALESCE(-SUM(room_vault), 0) AS paid FROM room_flow_ledger WHERE room_id = ? AND kind = 'challenge' AND created > ?`,
                            [roomId, now() - DAY]))[0];
  const balance = Math.max(0, Math.floor(Number(r.bal) || 0));
  const paid24 = Math.max(0, Math.floor(Number(p.paid) || 0));
  const capAmt = Math.min(cap, Math.floor(((balance + paid24) * pct) / 100));
  const left = Math.max(0, Math.min(balance, capAmt - paid24));
  return { balance, paid24, cap: capAmt, left, pct, ...(roomMode ? { vault: "room" } : {}) };
}

async function vault(roomId, opts = {}) {
  await init();
  const R = await require("./rooms").get(String(roomId || ""));
  if (!R) return { ok: false, code: "no_room" };
  return { ok: true, room: R.id, on: CONFIG.on, ...(await budget(R.id, opts)) };
}

/** Pay one prize out of the room's escrow. See the header. */
async function payout(roomId, b = {}) {
  await init();
  const rawRef = String(b.ref || "");
  const amount = Math.floor(Number(b.amount));
  const min = Math.max(1, Math.floor(Number(b.min) || 1));
  if (!REF_RE.test(rawRef) || !Number.isFinite(amount) || amount <= 0 || amount > 1e9 || !b.userId) {
    return { ok: false, code: "bad", paid: 0 };
  }
  const R = await require("./rooms").get(String(roomId || ""));
  if (!R) return { ok: false, code: "no_room", paid: 0 };
  if (!CONFIG.on) return { ok: false, code: "off", paid: 0 };
  const ledger = require("./ledger");
  const ref = "challenge:" + rawRef;
  try {
    return await require("./boosts").tx(async () => {
      const had = (await getQuery("SELECT * FROM room_flow_ledger WHERE ref = ?", [ref]))[0];
      if (had) return { ok: true, dup: true, paid: -had.room_vault, room: had.room_id, ...(had.rv_to === "room" ? { vault: "room" } : {}) };
      const roomMode = b.vault === "room";
      if (!roomMode && require("./funding").roomVaultsLive()) throw new Refuse("moved");     // E-3: see the header
      const uid = await ledger.resolveUserId(String(b.userId));
      if (!uid) throw new Refuse("no_account");
      const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [uid]))[0];
      const bud = await budget(R.id, b);
      if (bud.balance <= 0) throw new Refuse("empty");
      const pay = Math.min(amount, CONFIG.payout_max, bud.left, bud.balance);
      if (pay < min) throw new Refuse(bud.balance < min ? "empty" : "cap");
      const t = now();
      const cat = String(b.cat || "").replace(/[^a-z]/g, "").slice(0, 12);
      const score = Number.isFinite(Number(b.score)) ? Math.max(0, Math.min(10, Number(b.score))) : null;
      await runQuery(`INSERT INTO room_flow_ledger (ref, kind, room_id, payer_id, payer_name, amount, fortknox, room_vault, owner_self, via, created, detail, rv_to)
                      VALUES (?, 'challenge', ?, ?, ?, ?, 0, ?, 0, 'chat', ?, ?, ?)`,
                     [ref, R.id, uid, u ? u.username : null, -pay, -pay, t,
                      `mic challenge ${cat || "?"}${score !== null ? " " + score + "/10" : ""}${b.login ? " by " + String(b.login).slice(0, 40) : ""}`.slice(0, 200),
                      roomMode ? "room" : null]);
      await ledger.postOrThrow(uid, pay, `🎤 mic challenge prize p/${R.slug}`.slice(0, 120), { source: "challengepay" });
      return { ok: true, dup: false, paid: pay, balance: bud.balance - pay, left: bud.left - pay, room: R.id, username: u ? u.username : null,
               ...(roomMode ? { vault: "room" } : {}) };
    });
  } catch (e) {
    if (e && e.refuse) return { ok: false, code: e.code, paid: 0 };
    if (e && e.code === ledger.E_TARGET_NOT_FOUND) return { ok: false, code: "no_account", paid: 0 };
    throw e;
  }
}

/** Book a head-to-head fee like a boost (Fort Knox half + this room's escrow half). See the header. */
async function fee(roomId, b = {}) {
  await init();
  const rawRef = String(b.ref || "");
  const amount = Math.floor(Number(b.amount));
  if (!REF_RE.test(rawRef) || !Number.isFinite(amount) || amount <= 0 || amount > 1e9) return { ok: false, code: "bad" };
  const R = await require("./rooms").get(String(roomId || ""));
  const players = [b.a, b.b].map((x) => String(x || "").trim().toLowerCase()).filter(Boolean);
  const ownerCf = R && R.owner && R.owner.camfrog ? String(R.owner.camfrog).toLowerCase() : null;
  // no pad = nowhere to hold a room half: all of it to Fort Knox, same as the owner playing in their own pad
  const ownerSelf = !R || !!(ownerCf && players.includes(ownerCf));
  const roomKey = R ? R.id : String(roomId || "").slice(0, 80) || "unknown";
  const ref = "chalfee:" + rawRef;
  const B = require("./boosts");
  return B.tx(async () => {
    const had = (await getQuery("SELECT * FROM room_flow_ledger WHERE ref = ?", [ref]))[0];
    if (had) return { ok: true, dup: true, fortknox: had.fortknox, room_vault: had.room_vault };
    const row = await B.routeInTx({ ref, kind: "challenge_fee", room_id: roomKey, payer_id: null,
                                    payer_name: players.join(" vs ").slice(0, 80) || null, amount, owner_self: ownerSelf,
                                    via: "chat", flow: "challenge_fee", detail: `mic challenge head-to-head fee ${rawRef}` });
    return { ok: true, dup: false, fortknox: row.fortknox, room_vault: row.room_vault, fk_to: row.fk_to };
  });
}

function register(app, { addUser, isBotToken }) {
  const bot = (req, res) => {
    if (!isBotToken((req.body || {}).password)) { res.status(403).json({ error: "unauthorized" }); return false; }
    return true;
  };
  const fail = (res, e) => { console.error("[challengepay]", e); res.status(500).json({ ok: false, error: "Something went wrong - nothing was paid." }); };
  app.post("/api/rooms/:room/challenge/payout", async (req, res) => {
    if (!bot(req, res)) return;
    try {
      const r = await payout(req.params.room, req.body || {});
      if (r.ok && !r.dup) {
        try { await require("./rooms").event(r.room, "challenge-prize", r.username || "", `${r.paid} PAT from the room vault${r.vault === "room" ? "" : " escrow"}`); } catch (e) { /* audit only */ }
      }
      res.json(r);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:room/challenge/vault", async (req, res) => {
    if (!bot(req, res)) return;
    try { res.json(await vault(req.params.room, req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:room/challenge/fee", async (req, res) => {
    if (!bot(req, res)) return;
    try { res.json(await fee(req.params.room, req.body || {})); } catch (e) { fail(res, e); }
  });
  app.get("/api/challenge/admin", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!require("./rooms").isStaff(req.user)) return res.status(403).json({ ok: false, error: "Admins only." });
      await init();
      res.json({ ok: true, config: config(), escrow: await require("./boosts").escrow() });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/challenge/admin", addUser, async (req, res) => {
    try {
      if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
      if (!require("./rooms").isStaff(req.user)) return res.status(403).json({ ok: false, error: "Admins only." });
      const c = await setConfig(req.body || {});
      try { await require("./rooms").event(null, "challenge-config", req.user.username, JSON.stringify(c)); } catch (e) { /* audit only */ }
      res.json({ ok: true, config: c });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, config, setConfig, cleanConfig, budget, vault, payout, fee, register, DEFAULTS,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
