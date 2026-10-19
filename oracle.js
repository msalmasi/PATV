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
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

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
      // 1.99uc: /admin/oracle - the final outcome, who decided it, an admin's reason; one row per admin action (its idempotency key)
      for (const col of ["final_outcome TEXT", "decided_by TEXT", "admin_reason TEXT"]) {
        await runQuery(`ALTER TABLE oracle_proposals ADD COLUMN ${col}`).catch(() => {});
      }
      await runQuery(`CREATE TABLE IF NOT EXISTS oracle_admin_actions (
        idem TEXT PRIMARY KEY, key TEXT NOT NULL, action TEXT NOT NULL, admin_id TEXT, admin TEXT, at INTEGER NOT NULL, args TEXT, result TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS oracle_admin_actions_key ON oracle_admin_actions (key, at)");
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
    // actor (1.99uc): an admin's settle from /admin/oracle passes its own ({admin: true, ...}); the window's settle is Pepe's judge
    settle: async (ref, outcome, key, pepeLogin, actor) => G().act(game, { verb: "settle", idem: `oracle-${key}`.slice(0, 120).replace(/[^A-Za-z0-9_.:@\-]/g, "-"),
      actor: actor || { pepe: true, login: pepeLogin || "pepe", via: "oracle" }, args: { ref, outcome } }),
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
/** Disputes that still count (1.99uc: an admin can reject one on /admin/oracle; it stays on the record, marked). */
const activeDisputes = (ds) => (ds || []).filter((d) => !d.rejected).length;
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
    if (!cur || cur.state !== "proposed") return { ok: false, code: "no_proposal", error: `there's no AI proposal on ${ref} to dispute.` };
    const ds = parse(cur.disputes, []);
    if (ds.some((d) => low(d.login) === login)) return { ok: false, code: "already", error: "you've already disputed it." };
    // 1.99ade: the reason goes back to Pepe's AI judge - no invisible format characters (textclean.js)
    ds.push({ login, why: require("./textclean").oneLine(b.why, 160), ts: now() });
    const n = activeDisputes(ds);           // 1.99uc: a dispute an admin rejected doesn't count
    const escalate = n >= cur.need;
    await runQuery("UPDATE oracle_proposals SET disputes = ?, state = ? WHERE key = ?", [J(ds), escalate ? "disputed" : cur.state, cur.key]);
    if (escalate) await event(cur, "disputed", { disputes: ds.filter((d) => !d.rejected) });
    return { ok: true, key: cur.key, state: escalate ? "disputed" : cur.state, n, need: cur.need, outcome: cur.outcome, reason: cur.reason };
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
    for (const row of rows) {
      const R = resolver(row.kind);
      const owner = await R.owner(row.ref);
      // 1.99uc: each row is re-read and handled in ONE transaction, only while it is still "proposed" - an admin's action on
      // /admin/oracle (settle now / override / re-ask / extend) between the read above and here wins, and is never overwritten
      let res = null;
      const handled = await tx(async () => {
        const p = (await getQuery("SELECT * FROM oracle_proposals WHERE key = ?", [row.key]))[0];
        if (!p || p.state !== "proposed" || p.until > now()) return false;
        if (owner !== "site") {
          await runQuery("UPDATE oracle_proposals SET state = 'due', settler = 'pepe' WHERE key = ? AND state = 'proposed'", [p.key]);
          await event(p, "due", { outcome: p.outcome, raw: p.raw, result: p.result, reason: p.reason });
          return true;
        }
        if (!(await R.decidable(p.ref))) {
          await runQuery("UPDATE oracle_proposals SET state = 'superseded', settled_at = ? WHERE key = ?", [now(), p.key]);
          await event(p, "superseded", { why: "already decided" });
          return true;
        }
        try { res = await R.settle(p.ref, p.outcome, p.key, pepeLogin); } catch (e) { res = { ok: false, error: e.message }; }
        const ok = !!(res && res.ok);
        await runQuery(`UPDATE oracle_proposals SET state = ?, settler = 'site', settled_at = ?, settle_result = ?, final_outcome = ?, decided_by = ?
                        WHERE key = ?`, [ok ? "settled" : "failed", now(), J({ ok, error: res && res.error, code: res && res.code }),
                                         ok ? p.outcome : null, ok ? "window" : null, p.key]);
        await event(p, ok ? "settled" : "failed", { outcome: p.outcome, error: res && res.error });
        return true;
      });
      if (res && !res.ok) console.error(`[oracle] ${row.kind} ${row.ref}: settle "${row.outcome}" failed: ${res.error}`);
      if (handled) done.push(row.key);
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
  const moved = await tx(async () => {
    const r = await runQuery(`UPDATE oracle_proposals SET state = ?, settled_at = ?, settle_result = ?, final_outcome = COALESCE(?, final_outcome),
                              decided_by = COALESCE(decided_by, 'pepe') WHERE key = ? AND state = 'due'`,
                             [ok ? "settled" : "failed", now(), J({ ok, error: b.error ? String(b.error).slice(0, 300) : null, by: "pepe" }), ok ? p.outcome : null, key]);
    if (!r || !r.changes) return false;
    await event(p, ok ? "settled" : "failed", { outcome: p.outcome, by: "pepe", error: b.error || null });
    return true;
  });
  if (!moved) return { ok: true, already: true, state: ((await getQuery("SELECT state FROM oracle_proposals WHERE key = ?", [key]))[0] || {}).state };
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

// ── /admin/oracle (1.99uc): the admins' list of proposals, one proposal's record, and their actions on it ──
// Every action is keyed by the page's idempotency key (one per confirmed click; the same key answers the stored result),
// runs in ONE transaction with a fresh read of the proposal (so it can't race the window's tick or another admin), and is
// written to admin_audit. Settles go through the item's resolver with the admin as the actor - the same keyed settle the
// window uses, so an item can't be settled twice (the engine refuses a decided item).
const STATUS_FILTERS = ["window", "proposed", "disputed", "due", "settled", "overridden", "failed", "superseded"];
const ADMIN_ACTIONS = ["extend", "uphold", "override", "void", "reject_dispute", "reask"];
const ADM_IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SETTLE_FROM = ["proposed", "disputed", "failed"];
const REOPEN_MS = 15 * 60 * 1000;          // rejecting the dispute that escalated a call reopens its window for at least this long
const CAPS_FRESH_MS = 10 * 60 * 1000;      // Pepe tells the site what his feed reader handles on every poll (20 s)
const DAY = 86400 * 1000;

function dayStart(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
/** Pepe's feed reader lists the events it understands beyond the contract's first set ("reask"). */
async function noteCaps(caps) {
  if (!Array.isArray(caps)) return;
  await setMeta("pepe_caps", { caps: caps.map((c) => String(c).slice(0, 30)).slice(0, 20), at: now() });
}
async function pepeCan(cap) {
  const c = await meta("pepe_caps");
  return !!(c && Array.isArray(c.caps) && c.caps.includes(cap) && now() - Number(c.at || 0) < CAPS_FRESH_MS);
}
/** Who decided it: {by: "admin"|"window"|"pepe", name} (older rows have no decided_by: the settler's). */
function decidedBy(p) {
  const d = String(p.decided_by || "");
  if (d.startsWith("admin:")) return { by: "admin", name: d.slice(6) };
  if (d === "window" || d === "pepe") return { by: d, name: null };
  if (p.state === "settled") return { by: p.settler === "pepe" ? "pepe" : "window", name: null };
  return null;
}
function evidenceSummary(ev) {
  if (ev == null) return "";
  if (typeof ev === "string") return ev;
  if (typeof ev !== "object") return String(ev);
  if (typeof ev.text === "string" && ev.text) return ev.text;
  if (ev.price && typeof ev.price === "object") return `price check: ${ev.price.symbol || "?"} ${ev.price.source || ""}`.trim();
  for (const v of Object.values(ev)) if (typeof v === "string" && v) return v;
  return "";
}
function shape(p) {
  const fin = p.final_outcome || (p.state === "settled" ? p.outcome : null);
  return { key: p.key, kind: p.kind, ref: p.ref, outcome: p.outcome, result: p.result, raw: p.raw, confidence: p.confidence, reason: p.reason,
           evidence: p.evidence, summary: evidenceSummary(p.evidence).slice(0, 2000), judge: p.judge, state: p.state, owner: p.settler,
           created: p.created, until: p.until, need: p.need, disputes: p.disputes, n_disputes: p.disputes.length, n_active: activeDisputes(p.disputes),
           final_outcome: fin, decided: decidedBy(p), settled_at: p.settled_at, settle_result: p.settle_result, admin_reason: p.admin_reason };
}
/** The item a proposal is about, from the site's copies (markets / wagers tables): its link, title, status and options. */
async function itemInfo(kind, ref) {
  const id = Number(String(ref).replace(/^\D+/, "")) || 0;
  const out = { id, link: kind === "wager" ? "/wagers" : `/markets/${id}`, title: null, status: null, options: [] };
  try {
    const r = (await getQuery(`SELECT data FROM ${kind === "wager" ? "wagers" : "markets"} WHERE id = ?`, [id]))[0];
    if (r) {
      const d = JSON.parse(r.data);
      out.title = String(d.question || d.terms || "").slice(0, 300) || null;
      out.status = d.status ? String(d.status) : null;
      out.options = (kind === "wager" ? [d.creator, d.opponent] : (d.options || [])).filter(Boolean).map((o) => String(o).slice(0, 60)).slice(0, 12);
    }
  } catch (e) { /* no copy of it here (yet) */ }
  return out;
}

async function adminList(q = {}) {
  await init();
  const where = [], args = [];
  const status = STATUS_FILTERS.includes(q.status) ? q.status : "";
  const kind = KINDS.includes(q.kind) ? q.kind : "";
  if (status === "window") { where.push("state = 'proposed' AND until > ?"); args.push(now()); } else if (status) { where.push("state = ?"); args.push(status); }
  if (kind) { where.push("kind = ?"); args.push(kind); }
  const from = dayStart(q.from), to = dayStart(q.to);
  if (from != null) { where.push("created >= ?"); args.push(from); }
  if (to != null) { where.push("created < ?"); args.push(to + DAY); }
  const before = Math.floor(Number(q.before) || 0);
  if (before > 0) { where.push("created < ?"); args.push(before); }
  const limit = Math.min(200, Math.max(1, Math.floor(Number(q.limit) || 50)));
  const rows = await getQuery(`SELECT * FROM oracle_proposals ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created DESC, key DESC LIMIT ?`,
                              [...args, limit + 1]);
  const items = rows.slice(0, limit).map((r) => shape(rowOut(r)));
  const cache = {};
  for (const it of items) {
    const ck = `${it.kind}:${it.ref}`;
    it.item = cache[ck] || (cache[ck] = await itemInfo(it.kind, it.ref));
  }
  const more = rows.length > limit;
  return { items, more, next: more && items.length ? items[items.length - 1].created : null,
           filters: { status, kind, from: from != null ? String(q.from) : "", to: to != null ? String(q.to) : "" } };
}
async function adminSummary() {
  await init();
  const t = now();
  const r = (await getQuery(`SELECT SUM(CASE WHEN state = 'proposed' AND until > ? THEN 1 ELSE 0 END) AS win,
      SUM(CASE WHEN state = 'disputed' THEN 1 ELSE 0 END) AS disputed, SUM(CASE WHEN state = 'due' THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN state IN ('settled', 'overridden') AND settled_at >= ? THEN 1 ELSE 0 END) AS settled7 FROM oracle_proposals`, [t, t - 7 * DAY]))[0] || {};
  return { window: r.win || 0, disputed: r.disputed || 0, due: r.due || 0, failed: r.failed || 0, settled7: r.settled7 || 0, enabled: await enabled() };
}
/** What an admin may do to this proposal now: {action: {ok, why}} (why: state | pepe_owned | decided | no_caps | no_disputes). */
async function availability(p) {
  const R = resolver(p.kind);
  const owner = await R.owner(p.ref).catch(() => "pepe");
  const decidable = owner === "site" ? await R.decidable(p.ref).catch(() => false) : true;
  const yes = { ok: true }, no = (why) => ({ ok: false, why });
  const settleable = SETTLE_FROM.includes(p.state);
  const siteSettle = !settleable ? no("state") : owner !== "site" ? no("pepe_owned") : !decidable ? no("decided") : yes;
  return {
    owner, decidable,
    extend: p.state === "proposed" ? yes : no("state"),
    uphold: owner === "site" ? siteSettle : p.state === "proposed" ? yes : no(settleable ? "pepe_owned" : "state"),
    override: siteSettle,
    void: siteSettle,
    reject_dispute: !["proposed", "disputed"].includes(p.state) ? no("state") : activeDisputes(p.disputes) ? yes : no("no_disputes"),
    reask: !settleable ? no("state") : !decidable ? no("decided") : (await pepeCan("reask")) ? yes : no("no_caps"),
  };
}
async function adminDetail(key) {
  await init();
  const r = (await getQuery("SELECT * FROM oracle_proposals WHERE key = ?", [String(key || "")]))[0];
  if (!r) return null;
  const p = shape(rowOut(r));
  p.item = await itemInfo(p.kind, p.ref);
  p.can = await availability(p);
  const evs = await getQuery("SELECT seq, event, data, ts FROM oracle_events WHERE key = ? ORDER BY seq", [p.key]);
  const acts = (await getQuery("SELECT * FROM oracle_admin_actions WHERE key = ? ORDER BY at", [p.key]))
    .map((a) => ({ idem: a.idem, action: a.action, admin: a.admin, at: a.at, args: parse(a.args, {}), result: parse(a.result, {}) }));
  const tl = [{ ts: p.created, ev: "proposed", by: p.judge, outcome: p.result || p.outcome }];
  for (const d of p.disputes) tl.push({ ts: d.ts, ev: "dispute", by: d.login, text: d.why || "" });
  const seenIdem = new Set();
  const seenEv = new Set();
  for (const e of evs) {
    if (e.event === "proposed") continue;
    const d = parse(e.data, {});
    if (d.idem) seenIdem.add(d.idem);
    seenEv.add(e.event);
    tl.push({ ts: e.ts, ev: e.event === "settled" && d.override ? (d.void ? "voided" : "overridden") : e.event, by: d.by || null, outcome: d.outcome || null, text: d.error || d.why || d.reason || (e.event === "superseded" && d.by ? d.by : "") || "",
              admin: !!d.admin || !!d.idem });
  }
  for (const a of acts) if (!seenIdem.has(a.idem)) tl.push({ ts: a.at, ev: "admin_" + a.action, by: a.admin, text: a.args.reason || "", admin: true });
  // the feed keeps 14 days of events: an older proposal's end comes from the row
  if (p.settled_at && !["settled", "failed", "superseded"].some((x) => seenEv.has(x)) && !acts.length) tl.push({ ts: p.settled_at, ev: p.state, by: null, outcome: p.final_outcome });
  tl.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  p.timeline = tl;
  p.actions = acts;
  return p;
}

/** One admin action on a proposal. me = {userId, username, camfrogUsername}. b = {key, action, idem, minutes, outcome, reason, login}. */
async function adminAct(me, b) {
  await init();
  const action = String(b.action || "");
  if (!ADMIN_ACTIONS.includes(action)) throw new Refuse(400, "unknown action", "E_BAD_ACTION");
  const idem = String(b.idem || "");
  if (!ADM_IDEM_RE.test(idem)) throw new Refuse(400, "bad request key - reload the page", "E_BAD_IDEM");
  const key = String(b.key || "");
  const reason = String(b.reason || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
  const admin = String(me.username || "admin").slice(0, 60);
  return tx(async () => {
    const prev = (await getQuery("SELECT * FROM oracle_admin_actions WHERE idem = ?", [idem]))[0];
    if (prev) {
      if (prev.key !== key || prev.action !== action) throw new Refuse(409, "that request key was already used for something else - reload the page", "E_IDEM_REUSED");
      return Object.assign(parse(prev.result, {}), { already: true });
    }
    const row = (await getQuery("SELECT * FROM oracle_proposals WHERE key = ?", [key]))[0];
    if (!row) throw new Refuse(404, "no such proposal", "E_NOT_FOUND");
    const p = rowOut(row);
    const can = await availability(p);
    const gate = can[action];
    if (!gate.ok) {
      const msg = { state: `not while it is ${p.state}`, pepe_owned: `${p.ref} lives in Pepe - settle it in the room (!${p.kind === "wager" ? "wager" : "market"} settle ${p.ref} <result|void>)`,
                    decided: `${p.ref} is already decided`, no_caps: "Pepe isn't reading the oracle feed with re-ask support right now (his switch is off, he's offline, or he's an older build)",
                    no_disputes: "there are no open disputes on it" }[gate.why];
      throw new Refuse(409, msg || "not possible now", "E_" + String(gate.why || "state").toUpperCase());
    }
    const t = now();
    const by = `admin:${admin}`;
    const actor = { admin: true, userId: me.userId, username: me.username, login: me.camfrogUsername || me.username, via: "oracle" };
    const settleAs = async (outcome) => {
      let res;
      try { res = await resolver(p.kind).settle(p.ref, outcome, `${p.key}:adm:${idem}`, null, actor); } catch (e) { res = { ok: false, error: e.message }; }
      if (!res || !res.ok) throw new Refuse(409, `the settle was refused: ${(res && (res.error || res.code)) || "unknown"} - nothing changed`, "E_SETTLE");
      return res;
    };
    let result, args = {};
    if (action === "extend") {
      const mins = Math.floor(Number(b.minutes));
      if (!(mins >= 5 && mins <= 7 * 24 * 60)) throw new Refuse(400, "extend by 5 minutes to 7 days", "E_BAD_MINUTES");
      const until = Math.max(p.until, t) + mins * 60000;
      await runQuery("UPDATE oracle_proposals SET until = ? WHERE key = ?", [until, p.key]);
      await event(p, "extended", { by: admin, admin: true, minutes: mins, until, reason, idem });
      args = { minutes: mins, reason };
      result = { ok: true, state: p.state, until };
    } else if (action === "uphold") {
      if (can.owner === "site") {
        const res = await settleAs(p.outcome);
        await runQuery(`UPDATE oracle_proposals SET state = 'settled', settler = 'site', settled_at = ?, settle_result = ?, final_outcome = ?, decided_by = ?,
                        admin_reason = ? WHERE key = ?`, [t, J({ ok: true, by, ref: res.ref || p.ref }), p.outcome, by, reason || null, p.key]);
        await event(p, "settled", { outcome: p.outcome, by: admin, admin: true, reason, idem });
        result = { ok: true, state: "settled", outcome: p.outcome };
      } else {
        // Pepe owns it: the call goes "due" now (as when the window ends) and Pepe settles it with his own copy of the call
        await runQuery("UPDATE oracle_proposals SET state = 'due', settler = 'pepe', decided_by = ?, admin_reason = ? WHERE key = ?", [by, reason || null, p.key]);
        await event(p, "due", { outcome: p.outcome, raw: p.raw, result: p.result, reason: p.reason, by: admin, admin: true, idem });
        result = { ok: true, state: "due", outcome: p.outcome };
      }
      args = { reason };
    } else if (action === "override" || action === "void") {
      if (reason.length < 4) throw new Refuse(400, "say why (at least a few words)", "E_NEED_REASON");
      let outcome;
      if (action === "void") outcome = p.kind === "wager" ? "void" : `void ${reason}`.slice(0, 300);
      else {
        outcome = String(b.outcome || "").trim().slice(0, 300);
        if (!outcome) throw new Refuse(400, "pick the outcome", "E_NEED_OUTCOME");
        if (/^void\b/i.test(outcome)) throw new Refuse(400, "use Void / refund to void it", "E_USE_VOID");
        if (outcome.toLowerCase() === String(p.outcome).toLowerCase()) throw new Refuse(400, "that's the judge's call - use Settle now", "E_SAME");
      }
      const res = await settleAs(outcome);
      await runQuery(`UPDATE oracle_proposals SET state = 'overridden', settler = 'site', settled_at = ?, settle_result = ?, final_outcome = ?, decided_by = ?,
                      admin_reason = ? WHERE key = ?`, [t, J({ ok: true, by, ref: res.ref || p.ref }), outcome, by, reason, p.key]);
      await event(p, "settled", { outcome, judge_outcome: p.outcome, override: true, void: action === "void", by: admin, admin: true, reason, idem });
      args = { outcome, reason };
      result = { ok: true, state: "overridden", outcome };
    } else if (action === "reject_dispute") {
      const who = low(b.login);
      const ds = p.disputes;
      const d = ds.find((x) => low(x.login) === who && !x.rejected);
      if (!d) throw new Refuse(404, "no open dispute from them", "E_NO_DISPUTE");
      d.rejected = { by: admin, at: t, why: reason };
      let state = p.state, until = p.until, reopened = false;
      if (p.state === "disputed" && activeDisputes(ds) < p.need && can.owner === "site") {
        // below the bar again: back in its window (reopened for a while so others can still object); a Pepe-owned call stays
        // disputed - his copy of it is disputed and he only settles a "due" call he still holds as proposed
        state = "proposed"; until = Math.max(p.until, t + REOPEN_MS); reopened = true;
      }
      await runQuery("UPDATE oracle_proposals SET disputes = ?, state = ?, until = ? WHERE key = ?", [J(ds), state, until, p.key]);
      await event(p, "dispute_rejected", { login: who, by: admin, admin: true, reason, reopened, until, idem });
      args = { login: who, reason };
      result = { ok: true, state, until, reopened, active: activeDisputes(ds) };
    } else if (action === "reask") {
      await runQuery("UPDATE oracle_proposals SET state = 'superseded', settled_at = ?, decided_by = ?, admin_reason = ? WHERE key = ?", [t, by, reason || null, p.key]);
      await event(p, "reask", { by: admin, admin: true, reason, idem });
      args = { reason };
      result = { ok: true, state: "superseded" };
    }
    result.key = p.key;
    await runQuery("INSERT INTO oracle_admin_actions (idem, key, action, admin_id, admin, at, args, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                   [idem, p.key, action, String(me.userId || ""), admin, t, J(args), J(result)]);
    await require("./adminaudit").record({ userId: String(me.userId || ""), username: admin }, `oracle.${action}`, null,
                                         { key: p.key, kind: p.kind, ref: p.ref, judge_outcome: p.outcome, ...args, state: result.state }, reason || null);
    return result;
  });
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
  // 1.99uc: Pepe lists the extra events his reader handles (caps: ["reask"]) - /admin/oracle offers "re-ask" only while he does
  app.post("/api/oracle/bot/feed", bot(async (b) => { if (b.caps) await noteCaps(b.caps); return feed(b.after, b.limit); }));
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
    if (!SP.can(row, "econ.backend_cutover")) return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    await setMeta("enabled", !!(req.body || {}).on);
    res.json({ ok: true, enabled: await enabled() });
  });
}

module.exports = { init, register, enabled, setMeta, propose, dispute, tick, settled, feed, get, registerResolver, RESOLVERS, Refuse,
                   adminList, adminSummary, adminDetail, adminAct, noteCaps, STATUS_FILTERS, KINDS, ADMIN_ACTIONS };
