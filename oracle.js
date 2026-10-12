// oracle.js — Phase 5 (5.15) of the backend migration: the AI market judge becomes an ORACLE CLIENT of the site.
//
// The judge itself stays in Pepe (pepe_aijudge.py): it needs his Camfrog records (chat logs, mic transcripts, joins, cams,
// his vision check) and the LLMs. It only PROPOSES an outcome here; the site records the proposal, runs the dispute window
// and settles. Contract (docs/oracle-contract.md):
//
//   POST /api/oracle/bot/propose  {key, kind: market|pool|wager, ref, outcome, raw, result, confidence, reason, evidence,
//                                  window_s, need_disputes, judge}
//        -> {ok, key, state, until, owner}. Idempotent by `key` (Pepe's "aj:<kind>:<id>:<try>"); a new proposal on an item
//           supersedes the open one. `outcome` is the exact settle argument (an option / a winner's login / "void <why>").
//   POST /api/oracle/bot/dispute  {kind, ref, login, why, checked}  (Pepe checked the person is in it) -> {ok, state, n, need}
//   POST /api/oracle/bot/feed     {after} -> {ok, events: [{seq, key, kind, ref, event, data}], last}  (Pepe's cursor)
//   POST /api/oracle/bot/settled  {key, ok, error}   Pepe settled a "due" proposal on his side (the item lives in Pepe)
//   POST /api/oracle/bot/get      {kind, ref} -> the open / last proposal
//
// Who settles when the window ends (no dispute): the item's OWNER, from its resolver.
//   * site-owned (escrow pools / wagers while they live here - escrow/games.js `live:<game>`; the LMSR markets once the
//     Phase 3 capital engine registers a "market" resolver): the site settles them itself, as Pepe's AI judge (actor
//     {pepe: true}, keyed "oracle:<key>") - one site transition, no Pepe needed;
//   * Pepe-owned (the same games while they still live in Pepe): the proposal becomes "due" and goes out on the feed; Pepe
//     settles it with his normal settle and acks /settled.
// A resolver is {owner(ref) -> "site"|"pepe", settle(ref, outcome, key, pepeLogin) -> {ok, error}, decidable(ref) -> bool}.
// Phase 3 plugs its markets in with oracle.registerResolver("market", {...}) - nothing else here changes.
//
// The switch (like every move): oracle_meta.enabled (default on on staging, off on prod) + Pepe's `!aijudge backend on|off`.
// With Pepe's switch on and the site down, his proposals wait under their keys; nothing is finalised on his side.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const KEY_RE = /^[A-Za-z0-9_.:@\-]{6,160}$/;
const KINDS = ["market", "pool", "wager"];
const REF_RE = /^[A-Za-z]?\d{1,9}$/;
const OPEN = ["proposed", "disputed", "due"];
const FEED_KEEP_MS = 14 * 86400 * 1000;
const now = () => Date.now();
const J = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { if (s == null) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const low = (s) => String(s == null ? "" : s).trim().replace(/^@+/, "").toLowerCase();

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS oracle_proposals (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, outcome TEXT NOT NULL, raw TEXT, result TEXT, confidence REAL,
        reason TEXT, evidence TEXT, judge TEXT, state TEXT NOT NULL, settler TEXT, created INTEGER NOT NULL, until INTEGER NOT NULL,
        need INTEGER NOT NULL DEFAULT 2, disputes TEXT NOT NULL DEFAULT '[]', settled_at INTEGER, settle_result TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS oracle_proposals_item ON oracle_proposals (kind, ref, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS oracle_proposals_state ON oracle_proposals (state, until)");
      await runQuery(`CREATE TABLE IF NOT EXISTS oracle_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, kind TEXT, ref TEXT, event TEXT NOT NULL, data TEXT, ts INTEGER NOT NULL)`);
      await runQuery("CREATE TABLE IF NOT EXISTS oracle_meta (key TEXT PRIMARY KEY, value TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM oracle_meta WHERE key = ?", [key]))[0];
  return r ? parse(r.value, null) : null;
}
const setMeta = (key, v) => runQuery("INSERT INTO oracle_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, J(v)]);
/** May Pepe's judge propose here? Default: on on staging (STAGING env), off on prod until an admin turns it on. */
async function enabled() {
  const v = await meta("enabled");
  if (v === true || v === false) return v;
  return !!process.env.STAGING;
}

// ── resolvers: who owns an item, and the site's settle transition for the ones it owns ──
const RESOLVERS = {};
function registerResolver(kind, r) { RESOLVERS[kind] = r; }
const pepeOwned = { owner: async () => "pepe", settle: async () => ({ ok: false, error: "the item lives in Pepe" }), decidable: async () => true };
function escrowResolver(game, decidableStatuses) {
  const G = () => require("./escrow/games");
  return {
    owner: async () => ((await G().gameLive(game).catch(() => false)) ? "site" : "pepe"),
    decidable: async (ref) => {
      const rec = await G().load(game, Number(String(ref).replace(/^\D+/, ""))).catch(() => null);
      return !!rec && decidableStatuses.includes(rec.status);
    },
    settle: async (ref, outcome, key, pepeLogin) => G().act(game, { verb: "settle", idem: `oracle-${key}`.slice(0, 120).replace(/[^A-Za-z0-9_.:@\-]/g, "-"),
      actor: { pepe: true, login: pepeLogin || "pepe", via: "oracle" }, args: { ref, outcome } }),
    participants: async (ref) => {
      const rec = await G().load(game, Number(String(ref).replace(/^\D+/, ""))).catch(() => null);
      if (!rec) return [];
      if (game === "wagers") return [rec.creator, rec.opponent].filter(Boolean).map(low);
      return [rec.creator, ...((rec.bets || []).map((b) => b.nick))].filter(Boolean).map(low);
    },
  };
}
registerResolver("pool", escrowResolver("pools", ["open", "closed"]));
registerResolver("wager", escrowResolver("wagers", ["active"]));
// "market" (LMSR): Pepe-owned until Phase 3's capital engine registers its resolver here
const resolver = (kind) => RESOLVERS[kind] || pepeOwned;

async function event(p, ev, data) {
  await runQuery("INSERT INTO oracle_events (key, kind, ref, event, data, ts) VALUES (?, ?, ?, ?, ?, ?)", [p.key, p.kind, p.ref, ev, J(data || {}), now()]);
}
const rowOut = (r) => r && Object.assign({}, r, { evidence: parse(r.evidence, null), disputes: parse(r.disputes, []), settle_result: parse(r.settle_result, null) });
async function openFor(kind, ref) {
  return (await getQuery(`SELECT * FROM oracle_proposals WHERE kind = ? AND ref = ? AND state IN (${OPEN.map(() => "?").join(",")}) ORDER BY created DESC LIMIT 1`,
                         [kind, ref, ...OPEN]))[0] || null;
}

/** Pepe proposes an outcome. -> {ok, key, state, until, owner} */
async function propose(b) {
  await init();
  if (!(await enabled())) throw new Refuse(409, "the oracle is switched off on this site", "E_FEATURE_OFF");
  const key = String(b.key || "");
  if (!KEY_RE.test(key)) throw new Refuse(400, "bad key");
  const kind = String(b.kind || "");
  if (!KINDS.includes(kind)) throw new Refuse(400, "bad kind");
  const ref = String(b.ref || "").toUpperCase();
  if (!REF_RE.test(ref)) throw new Refuse(400, "bad ref");
  const outcome = String(b.outcome || "").trim().slice(0, 300);
  if (!outcome) throw new Refuse(400, "no outcome");
  const prev = (await getQuery("SELECT * FROM oracle_proposals WHERE key = ?", [key]))[0];
  if (prev) return { ok: true, already: true, key, state: prev.state, until: prev.until, owner: prev.settler };
  const R = resolver(kind);
  const owner = await R.owner(ref);
  if (owner === "site" && !(await R.decidable(ref))) throw new Refuse(409, `${ref} can't be decided any more`, "E_NOT_DECIDABLE");
  const windowMs = Math.max(0, Math.min(7 * 86400, Number(b.window_s) || 3600)) * 1000;
  const need = Math.max(1, Math.min(10, Math.floor(Number(b.need_disputes) || (kind === "wager" ? 1 : 2))));
  const ev = b.evidence === undefined ? null : b.evidence;
  const evText = J(ev);
  if (evText.length > 20000) throw new Refuse(400, "evidence too large");
  const t = now();
  const row = { key, kind, ref, outcome, raw: b.raw == null ? null : String(b.raw).slice(0, 100), result: b.result == null ? null : String(b.result).slice(0, 100),
                confidence: Math.max(0, Math.min(1, Number(b.confidence) || 0)), reason: String(b.reason || "").slice(0, 400), evidence: evText,
                judge: String(b.judge || "pepe").slice(0, 60), state: "proposed", settler: owner, created: t, until: t + windowMs, need };
  await tx(async () => {
    const open = await openFor(kind, ref);
    if (open) {
      await runQuery("UPDATE oracle_proposals SET state = 'superseded' WHERE key = ?", [open.key]);
      await event(open, "superseded", { by: key });
    }
    await runQuery(`INSERT INTO oracle_proposals (key, kind, ref, outcome, raw, result, confidence, reason, evidence, judge, state, settler, created, until, need)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [row.key, row.kind, row.ref, row.outcome, row.raw, row.result, row.confidence, row.reason, row.evidence, row.judge, row.state,
                    row.settler, row.created, row.until, row.need]);
    await event(row, "proposed", { outcome, until: row.until, owner });
  });
  if (b.pepe_login) await setMeta("pepe_login", String(b.pepe_login).slice(0, 60));
  return { ok: true, key, state: "proposed", until: row.until, owner };
}

/** A participant objects (Pepe checked they're in it, or the site checks for its own items). -> {ok, state, n, need} */
async function dispute(b) {
  await init();
  const kind = String(b.kind || ""), ref = String(b.ref || "").toUpperCase();
  const login = low(b.login);
  if (!KINDS.includes(kind) || !REF_RE.test(ref) || !login) throw new Refuse(400, "kind, ref and login required");
  const p = await openFor(kind, ref);
  if (!p || p.state !== "proposed") return { ok: false, code: "no_proposal", error: `there's no AI proposal on ${ref} to dispute.` };
  const R = resolver(kind);
  if (!b.checked && R.participants) {
    const ps = await R.participants(ref);
    if (!ps.includes(login)) return { ok: false, code: "not_in_it", error: `only people with PAT in ${ref} can dispute it.` };
  }
  return tx(async () => {
    const cur = (await getQuery("SELECT * FROM oracle_proposals WHERE key = ?", [p.key]))[0];
    const ds = parse(cur.disputes, []);
    if (ds.some((d) => low(d.login) === login)) return { ok: false, code: "already", error: "you've already disputed it." };
    ds.push({ login, why: String(b.why || "").slice(0, 160), ts: now() });
    const escalate = ds.length >= cur.need;
    await runQuery("UPDATE oracle_proposals SET disputes = ?, state = ? WHERE key = ?", [J(ds), escalate ? "disputed" : cur.state, cur.key]);
    if (escalate) await event(cur, "disputed", { disputes: ds });
    return { ok: true, key: cur.key, state: escalate ? "disputed" : cur.state, n: ds.length, need: cur.need, outcome: cur.outcome, reason: cur.reason };
  });
}

/** The window ended without enough disputes: the owner settles. Runs from the tick (and tests). -> [keys handled] */
let ticking = false;
async function tick() {
  if (ticking) return [];
  ticking = true;
  const done = [];
  try {
    await init();
    const pepeLogin = (await meta("pepe_login")) || "pepe";
    const rows = await getQuery("SELECT * FROM oracle_proposals WHERE state = 'proposed' AND until <= ? ORDER BY until LIMIT 50", [now()]);
    for (const p of rows) {
      const R = resolver(p.kind);
      const owner = await R.owner(p.ref);
      if (owner !== "site") {
        await tx(async () => {
          await runQuery("UPDATE oracle_proposals SET state = 'due', settler = 'pepe' WHERE key = ? AND state = 'proposed'", [p.key]);
          await event(p, "due", { outcome: p.outcome, raw: p.raw, result: p.result, reason: p.reason });
        });
        done.push(p.key);
        continue;
      }
      if (!(await R.decidable(p.ref))) {
        await tx(async () => {
          await runQuery("UPDATE oracle_proposals SET state = 'superseded', settled_at = ? WHERE key = ?", [now(), p.key]);
          await event(p, "superseded", { why: "already decided" });
        });
        done.push(p.key);
        continue;
      }
      let res;
      try { res = await R.settle(p.ref, p.outcome, p.key, pepeLogin); } catch (e) { res = { ok: false, error: e.message }; }
      await tx(async () => {
        await runQuery("UPDATE oracle_proposals SET state = ?, settler = 'site', settled_at = ?, settle_result = ? WHERE key = ?",
                       [res && res.ok ? "settled" : "failed", now(), J({ ok: !!(res && res.ok), error: res && res.error, code: res && res.code }), p.key]);
        await event(p, res && res.ok ? "settled" : "failed", { outcome: p.outcome, error: res && res.error });
      });
      if (!(res && res.ok)) console.error(`[oracle] ${p.kind} ${p.ref}: settle "${p.outcome}" failed: ${res && res.error}`);
      done.push(p.key);
    }
    await runQuery("DELETE FROM oracle_events WHERE ts < ?", [now() - FEED_KEEP_MS]);
  } finally { ticking = false; }
  return done;
}

/** Pepe settled a due proposal on his side. */
async function settled(b) {
  await init();
  const key = String(b.key || "");
  const p = (await getQuery("SELECT * FROM oracle_proposals WHERE key = ?", [key]))[0];
  if (!p) throw new Refuse(404, "no such proposal");
  if (p.state !== "due") return { ok: true, already: true, state: p.state };
  const ok = !!b.ok;
  await tx(async () => {
    await runQuery("UPDATE oracle_proposals SET state = ?, settled_at = ?, settle_result = ? WHERE key = ?",
                   [ok ? "settled" : "failed", now(), J({ ok, error: b.error ? String(b.error).slice(0, 300) : null, by: "pepe" }), key]);
    await event(p, ok ? "settled" : "failed", { outcome: p.outcome, by: "pepe", error: b.error || null });
  });
  return { ok: true, state: ok ? "settled" : "failed" };
}

async function feed(after, limit = 200) {
  await init();
  const rows = await getQuery("SELECT seq, key, kind, ref, event, data, ts FROM oracle_events WHERE seq > ? ORDER BY seq LIMIT ?",
                              [Math.max(0, Math.floor(Number(after) || 0)), Math.min(500, Math.max(1, Math.floor(Number(limit) || 200)))]);
  const last = (await getQuery("SELECT COALESCE(MAX(seq), 0) AS m FROM oracle_events"))[0].m;
  return { ok: true, events: rows.map((r) => Object.assign({}, r, { data: parse(r.data, {}) })), last };
}
async function get(kind, ref) {
  await init();
  const r = (await getQuery("SELECT * FROM oracle_proposals WHERE kind = ? AND ref = ? ORDER BY created DESC LIMIT 1", [String(kind), String(ref || "").toUpperCase()]))[0];
  return rowOut(r || null);
}

function register(app, { isBotToken, addUser }) {
  init().then(() => {
    if (process.env.NODE_TEST_CONTEXT) return;
    const iv = setInterval(() => tick().catch((e) => console.error("[oracle] tick:", e.message)), 20000);
    if (iv.unref) iv.unref();
  }).catch((e) => console.error("[oracle] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (e instanceof Refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      console.error(`[oracle] ${req.path}:`, e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  app.post("/api/oracle/bot/status", bot(async () => ({ ok: true, enabled: await enabled() })));
  app.post("/api/oracle/bot/propose", bot(propose));
  app.post("/api/oracle/bot/dispute", bot(dispute));
  app.post("/api/oracle/bot/settled", bot(settled));
  app.post("/api/oracle/bot/feed", bot((b) => feed(b.after, b.limit)));
  app.post("/api/oracle/bot/get", bot(async (b) => ({ ok: true, proposal: await get(b.kind, b.ref) })));
  // the public record of a ruling (the market / wager pages can show it)
  app.get("/api/oracle/:kind/:ref", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const p = await get(req.params.kind, req.params.ref);
      if (!p) return res.json({ ok: true, proposal: null });
      res.json({ ok: true, proposal: { kind: p.kind, ref: p.ref, outcome: p.result || p.outcome, confidence: p.confidence, reason: p.reason,
                                         state: p.state, created: p.created, until: p.until, disputes: p.disputes.length, need: p.need } });
    } catch (e) { res.status(500).json({ ok: false, error: "server_error" }); }
  });
  app.post("/api/admin/oracle", addUser, async (req, res) => {
    const uid = req.user && req.user.userId;
    if (!uid) return res.status(401).json({ ok: false, error: "Sign in first." });
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [uid]).catch(() => []))[0];
    if (!row || row.class !== "Admin") return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    await setMeta("enabled", !!(req.body || {}).on);
    res.json({ ok: true, enabled: await enabled() });
  });
}

module.exports = { init, register, enabled, setMeta, propose, dispute, tick, settled, feed, get, registerResolver, RESOLVERS, Refuse };
