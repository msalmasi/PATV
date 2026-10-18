// escrow/games.js — 1.99ou Phase 2: the site's escrow GAME engines (wagers, bounties, parimutuel pools, P2P loans) and their
// transport to Pepe. Each engine owns its records here (escrow_games: game + id -> data JSON) and moves money only through the
// escrow ledger's in-transaction primitives (escrow/ledger.js) - one SQLite transaction per action: the record, the hold /
// refund / settle and the event are written together or not at all.
//
// Per game (the user's rule: one switch per feature, the local path keeps working):
//   escrow_meta enabled:<game>   may Pepe hand this game over (default on on staging, off on prod)
//   escrow_meta live:<game>      the site owns it (its import ran and wasn't rolled back)
// A game can only go live on top of the live ledger (its stakes are ledger holds). While it is live:
//   - Pepe's chat verbs call POST /api/escrow/bot/act {game, verb, actor, args, idem} (keyed: the same idem answers the first
//     result) and he announces what happened from POST /api/escrow/bot/poll (events, long-poll, 48 h);
//   - the website's forms run here directly (actions.js /act cmd=wager|bounty|pool|loan, bounties.js /bounties/:id/:kind):
//     nothing is queued for Pepe;
//   - deadlines (offer expiry, wager deadlines, bounty expiry, pool closes, loan due dates) run on the site tick (15 s), with or
//     without Pepe;
//   - each engine keeps the existing display tables (wagers / bounties / markets) up to date itself, so the pages read the same
//     rows they always read.
// Fees: Pepe still owns the PAT Routing table; he publishes the effective shares of the escrow fee flows (POST
// /api/escrow/bot/fee-plans, re-sent when they change) and the engines split a fee exactly as his _route_fees does.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("../dbUtils");
const SP = require("../siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const L = require("./ledger");

const ENGINES = {};
function engine(game) {
  if (!ENGINES[game]) {
    try { ENGINES[game] = require(`./${game}`); } catch (e) { ENGINES[game] = null; }
  }
  return ENGINES[game];
}
const IDEM_RE = /^[A-Za-z0-9_.:@\-]{6,120}$/;
const now = () => Date.now();
const nowS = () => Math.floor(Date.now() / 1000);

// ── switches ──
let liveCache = {};
async function gameLive(game) {
  const c = liveCache[game];
  if (c && now() - c.at < 2000) return c.v;
  const v = !!(await L.meta(`live:${game}`)) && (await L.live());
  liveCache[game] = { at: now(), v };
  return v;
}
const forget = () => { liveCache = {}; };

// ── records ──
async function load(game, id) {
  const r = (await getQuery("SELECT data FROM escrow_games WHERE game = ? AND id = ?", [game, Math.trunc(Number(id) || 0)]))[0];
  if (!r) return null;
  try { return JSON.parse(r.data); } catch (e) { return null; }
}
async function list(game, statuses) {
  const rows = statuses && statuses.length
    ? await getQuery(`SELECT data FROM escrow_games WHERE game = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`, [game, ...statuses])
    : await getQuery("SELECT data FROM escrow_games WHERE game = ? ORDER BY id", [game]);
  return rows.map((r) => { try { return JSON.parse(r.data); } catch (e) { return null; } }).filter(Boolean);
}
async function save(game, rec) {
  await runQuery(`INSERT INTO escrow_games (game, id, status, deadline, data, updated) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(game, id) DO UPDATE SET status = excluded.status, deadline = excluded.deadline, data = excluded.data, updated = excluded.updated`,
                 [game, Math.trunc(rec.id), String(rec.status || ""), Math.trunc(Number(rec.deadline || rec.closes || 0)), JSON.stringify(rec), now()]);
  const e = engine(game);
  if (e && e.mirror) await e.mirror(rec);
}
async function nextId(game) {
  const n = ((await L.meta(`seq:${game}`)) || 0) + 1;
  await L.setMeta(`seq:${game}`, n);
  return n;
}

// ── fees: Pepe's effective shares of the escrow fee flows ──
const VAULT_DESTS = ["jackpot", "reserve", "stakers", "heist", "fortknox", "incentives", "mm", "bank"];
const DEFAULT_SHARES = { wager_fee: [["jackpot", 100]], market_fee: [["mm", 100]], bounty_fee: [["reserve", 100]],
                         loan_interest: [["reserve", 100]], donation: [["reserve", 100]] };
/** Pepe's _route_split (+ _stake_scale_split): shares in order, int(amount * p / 100) each, the rest to the Reserve. */
function split(shares, amount, k = 1) {
  amount = Math.trunc(Number(amount) || 0);
  if (amount <= 0) return [];
  const out = [];
  let used = 0;
  for (const [d, p] of shares || []) {
    const a = Math.trunc(amount * Number(p) / 100);
    if (a > 0) { out.push([String(d), a]); used += a; }
  }
  const rest = amount - used;
  if (rest > 0) {
    const i = out.findIndex(([d]) => d === "reserve");
    if (i >= 0) out[i][1] += rest; else out.push(["reserve", rest]);
  }
  if (!(k >= 1)) {
    const res = [];
    let back = 0;
    for (const [d, a] of out) {
      if (d === "stakers") {
        const keep = Math.trunc(a * Math.max(0, Number(k) || 0));
        back += a - keep;
        if (keep > 0) res.push([d, keep]);
      } else res.push([d, a]);
    }
    if (back) {
      const i = res.findIndex(([d]) => d === "reserve");
      if (i >= 0) res[i][1] += back; else res.push(["reserve", back]);
    }
    return res;
  }
  return out;
}
async function feePlans() { return (await L.meta("fee_plans")) || { k: 1, shares: {} }; }
/** _route_fees(flow, amount): the vault legs of the split. */
async function feeLegs(flow, amount) {
  const p = await feePlans();
  const shares = (p.shares && p.shares[flow]) || DEFAULT_SHARES[flow] || [["reserve", 100]];
  return split(shares, amount, p.k === undefined ? 1 : Number(p.k)).filter(([d]) => VAULT_DESTS.includes(d));
}

// ── accounts for actors ──
async function actorAccount(actor) {
  return L.accountFor({ userId: actor && actor.userId, username: actor && actor.username, login: actor && actor.login });
}
const same = (a, b) => !!a && !!b && String(a).trim().replace(/^@+/, "").toLowerCase() === String(b).trim().replace(/^@+/, "").toLowerCase();
/** Does this actor (Camfrog login and/or PATV username) match the participant {login, user}? */
function isWho(actor, p) {
  if (!actor || !p) return false;
  return same(actor.login, p.login) || same(actor.username, p.user) || same(actor.login, p.user) || same(actor.username, p.login);
}

// ── one action, keyed, in one transaction ──
async function act(game, body) {
  const e = engine(game);
  if (!e) throw new L.Refuse(404, "no such game", "E_NO_GAME");
  if (!(await gameLive(game))) return { ok: false, code: "not_live", error: `${game} still live in Pepe` };
  const verb = String(body.verb || "").toLowerCase();
  const actor = Object.assign({}, body.actor || {});
  actor.via = String(actor.via || body.channel || "room").slice(0, 12);
  const idem = body.idem ? String(body.idem) : null;
  if (e.READS && e.READS.includes(verb)) return Object.assign({ ok: true }, await e.read(verb, actor, body.args || {}));
  if (idem && !IDEM_RE.test(idem)) return { ok: false, code: "bad_request", error: "bad idem" };
  const key = idem ? `act:${game}:${idem}` : null;
  let out;
  try {
    out = await L.tx(async () => {
      if (key) {
        const dup = await L.seen(key);
        if (dup) return dup;
      }
      const res = await e.act(verb, actor, body.args || {}, { nowS: nowS() });
      if (res && res.ok && key) await L.record(key, { op: `act:${game}`, ref: res.ref, amount: 0, via: actor.via, result: res });
      if (res && res.ok) await L.bumpRev();
      if (res && !res.ok && res._rollback) throw Object.assign(new L.Refuse(409, res.error || res.code, res.code), { res });
      return res;
    });
  } catch (err) {
    if (L.isRefuse(err)) {
      if (err.res) { delete err.res._rollback; return err.res; }
      return { ok: false, code: refuseCode(err.code), error: err.message };
    }
    throw err;
  }
  L.wake();
  return out;
}
function refuseCode(c) {
  return ({ E_INSUFFICIENT_PAT: "insufficient", E_TARGET_NOT_FOUND: "no_account", E_CASINO_BANNED: "banned", E_NOT_HELD: "changed",
            E_POOLS_NOT_LIVE: "pools_not_live", E_INSUFFICIENT: "pool_short" })[c] || String(c || "failed").toLowerCase();
}

// ── the deadline tick ──
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!(await L.live())) return;
    for (const game of L.GAMES) {
      if (!(await gameLive(game))) continue;
      const e = engine(game);
      if (!e || !e.due) continue;
      let ids = [];
      try { ids = await e.due(nowS()); } catch (err) { console.error(`[escrow] ${game} due:`, err.message); continue; }
      for (const id of ids.slice(0, 50)) {
        try {
          await L.tx(async () => {
            const res = await e.expire(id, { nowS: nowS() });
            if (res && res.ok) await L.bumpRev();
          });
          L.wake();
        } catch (err) { console.error(`[escrow] ${game} deadline ${id}:`, err.message); }
      }
    }
  } finally { ticking = false; }
}

// ── the per-game cutover (Pepe's records -> here, the reverse, and the read-only export) ──
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
async function importGame(body) {
  const game = String(body.game || "");
  const e = engine(game);
  if (!e || !L.GAMES.includes(game)) throw new L.Refuse(404, "no such game", "E_NO_GAME");
  if (!(await L.enabled(game))) throw new L.Refuse(409, `the ${game} backend is switched off on this site`, "E_FEATURE_OFF");
  if (!(await L.live())) throw new L.Refuse(409, "the escrow ledger isn't live here yet - cut it over first", "E_NOT_LIVE");
  const key = String(body.key || "");
  if (!IDEM_RE.test(key)) throw new L.Refuse(400, "Bad request (key).", "E_BAD_KEY");
  const payload = String(body.payload || "");
  const digest = sha(payload);
  if (!payload || digest !== String(body.digest || "")) throw new L.Refuse(400, "digest mismatch", "E_DIGEST");
  const done = await L.meta(`imported:${game}`);
  if (done && done.key === key && !done.rolled_back) {
    if (done.digest === digest) return Object.assign({ ok: true, already: true }, done.answer || {});
    throw new L.Refuse(409, "this cutover key was already used with a different export", "E_ALREADY");
  }
  if (await L.meta(`live:${game}`)) throw new L.Refuse(409, `the site already owns ${game}`, "E_ALREADY");
  let x;
  try { x = JSON.parse(payload); } catch (err) { throw new L.Refuse(400, "payload is not JSON"); }
  const recs = e.cleanImport(x);                                        // throws Refuse on a bad record
  if (e.beforeImport) await e.beforeImport(recs);                      // a game's own precondition (bounties: no queued web actions)
  const totals = body.totals || {};
  const mine = e.importTotals(recs);                                    // {sum, count, holds:[ids]}
  if (mine.sum !== Math.floor(Number(totals.sum)) || mine.count !== Math.floor(Number(totals.count))) {
    throw new L.Refuse(400, `totals don't match: ${mine.sum} PAT in ${mine.count} live record(s) vs ${totals.sum} / ${totals.count}`, "E_TOTALS");
  }
  // every stake a live record names must be a held ledger hold with the same amount and ref
  const hs = await L.holdsByIds(mine.holds.map((h) => h.id));
  const byId = Object.fromEntries(hs.map((h) => [h.id, h]));
  const bad = mine.holds.filter((h) => !byId[h.id] || byId[h.id].state !== "held" || byId[h.id].amount !== h.amount || byId[h.id].ref !== h.ref);
  if (bad.length) {
    throw new L.Refuse(409, `stake(s) not held on the ledger as recorded: ${bad.slice(0, 8).map((h) => `${h.id}(${h.ref} ${h.amount}: ${byId[h.id] ? byId[h.id].state + " " + byId[h.id].amount : "missing"})`).join(", ")}`,
                       "E_HOLDS", { bad: bad.slice(0, 50) });
  }
  const answer = await L.tx(async () => {
    if (await L.meta(`live:${game}`)) throw new L.Refuse(409, "already imported", "E_ALREADY");
    for (const r of recs.records) await save(game, r);
    const seq = Math.max(Math.floor(Number(recs.seq) || 0), ...recs.records.map((r) => r.id), (await L.meta(`seq:${game}`)) || 0);
    await L.setMeta(`seq:${game}`, seq);
    const check = e.importTotals({ records: await list(game, e.LIVE), seq });
    if (check.sum !== mine.sum || check.count !== mine.count) throw new L.Refuse(500, `${game} reads ${check.sum} / ${check.count} after the import, not ${mine.sum} / ${mine.count}`, "E_VERIFY");
    await L.setMeta(`live:${game}`, true);
    const out = { game, sum: mine.sum, count: mine.count, records: recs.records.length, seq, holds: mine.holds.length };
    await L.record(`import:${game}:${key}`, { op: "import", ref: game, amount: mine.sum, via: String(body.actor || "pepe").slice(0, 40), result: Object.assign({ ok: true }, out) });
    await L.setMeta(`imported:${game}`, { key, digest, at: now(), answer: out });
    await L.bumpRev();
    return out;
  });
  forget();
  console.log(`[escrow] ${game}: imported ${answer.count} live record(s) holding ${answer.sum} PAT from Pepe (key ${key})`);
  return Object.assign({ ok: true }, answer);
}
async function exportGame(game) {
  const e = engine(game);
  if (!e) throw new L.Refuse(404, "no such game", "E_NO_GAME");
  const live = await list(game, e.LIVE);
  const t = e.importTotals({ records: live });
  return { ok: true, game, live: await gameLive(game), enabled: await L.enabled(game), seq: (await L.meta(`seq:${game}`)) || 0, sum: t.sum, count: t.count,
           records: await list(game), imported: await L.meta(`imported:${game}`) };
}
/** The reverse: every record (the live ones and the last 60 days of history) goes back to Pepe; live off; the holds stay
 *  on the ledger (Pepe moves them through it). Keyed: a retry answers the same records. */
async function rollbackGame({ game, key, actor }) {
  const e = engine(game);
  if (!e || !L.GAMES.includes(game)) throw new L.Refuse(404, "no such game", "E_NO_GAME");
  if (!IDEM_RE.test(String(key || ""))) throw new L.Refuse(400, "Bad request (key).", "E_BAD_KEY");
  const mk = `rollback:${game}:${key}`;
  const prev = (await L.status([mk]))[mk];
  if (prev) return Object.assign({}, prev, { dup: true });
  if (!(await L.meta(`live:${game}`))) throw new L.Refuse(409, `${game} isn't live here`, "E_NOT_LIVE");
  const out = await L.tx(async () => {
    const dup = await L.seen(mk);
    if (dup) return dup;
    const cutoff = nowS() - 60 * 86400;
    const recs = (await list(game)).filter((r) => e.LIVE.includes(r.status) || Number(r.ended || r.resolved || r.created || 0) >= cutoff);
    const t = e.importTotals({ records: recs.filter((r) => e.LIVE.includes(r.status)) });
    const res = { ok: true, game, key, records: recs, seq: (await L.meta(`seq:${game}`)) || 0, sum: t.sum, count: t.count };
    await L.record(mk, { op: "rollback", ref: game, amount: t.sum, via: String(actor || "pepe").slice(0, 40), result: res });
    await L.setMeta(`live:${game}`, false);
    const imp = await L.meta(`imported:${game}`);
    if (imp) await L.setMeta(`imported:${game}`, Object.assign({}, imp, { rolled_back: { key, at: now() } }));
    await L.bumpRev();
    return res;
  });
  forget();
  console.log(`[escrow] ${game}: ROLLBACK ${key} - ${out.count} live record(s) (${out.sum} PAT in stakes) back to Pepe`);
  return out;
}

// ── the website's forms (actions.js /act) ──
const CMD_GAME = { wager: "wagers", bounty: "bounties", pool: "pools", loan: "loans" };
/** /act cmd=<wager|bounty|pool|loan> while that game is live here: run it now. -> reply text | null (not ours: queue for Pepe). */
async function fromForm(userId, cmd, words, idem) {
  const game = CMD_GAME[cmd];
  if (!game || !(await gameLive(game))) return null;
  const e = engine(game);
  if (!e || !e.fromForm) return null;
  const u = (await getQuery("SELECT userId, username, camfrogUsername, class FROM users WHERE userId = ?", [userId]))[0];
  if (!u) return "Couldn't find your account.";
  const actor = { userId: u.userId, username: u.username, login: u.camfrogUsername || null, admin: SP.can(u, "escrow.override"), via: "web" };
  const parsed = await e.fromForm(words, actor);                     // (an engine may look its record up: loans)
  if (parsed === null) return null;                                  // a verb only Pepe can do (falls back to the queue)
  if (typeof parsed === "string") return parsed;                     // a form error
  const res = await act(game, { verb: parsed.verb, actor, args: parsed.args,
                                idem: /^[A-Za-z0-9_-]{8,64}$/.test(String(idem || "")) ? `web-${u.userId}-${idem}` : null });
  return e.webReply ? e.webReply(parsed.verb, res, parsed.args) : (res.ok ? "Done." : res.error || "Something went wrong — nothing changed.");
}

// ── routes ──
function register(app, { isBotToken }) {
  L.init().then(() => {
    const iv = setInterval(() => tick().catch((e) => console.error("[escrow] tick:", e.message)), 15000);
    if (iv.unref) iv.unref();
  }).catch((e) => console.error("[escrow] games init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (L.isRefuse(e)) return res.status(e.status).json(Object.assign({ ok: false, error: e.message, code: e.code }, e.extra || {}));
      console.error(`[escrow] ${req.path}:`, e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  app.post("/api/escrow/bot/act", bot((b) => act(String(b.game || ""), b)));
  app.post("/api/escrow/bot/poll", bot(async (b) => {
    const r = await L.events(b.after, Math.max(0, Math.min(8, Number(b.wait) || 0)) * 1000, b.games);
    return Object.assign({ ok: true, live: await L.live(), games: await L.gamesState(), rev: await L.rev() }, r);
  }));
  app.post("/api/escrow/bot/games", bot(async (b) => {
    const game = String(b.game || "");
    const e = engine(game);
    if (!e) return { ok: false, code: "E_NO_GAME" };
    const recs = b.all ? await list(game) : await list(game, e.LIVE.concat(e.RECENT || []));
    return { ok: true, game, live: await gameLive(game), seq: (await L.meta(`seq:${game}`)) || 0, records: recs.slice(-1000) };
  }));
  app.post("/api/escrow/bot/fee-plans", bot(async (b) => {
    const p = b.plans && typeof b.plans === "object" ? b.plans : null;
    if (!p || typeof p.shares !== "object") return { ok: false, code: "bad_request" };
    const clean = { k: Math.max(0, Math.min(1, Number(p.k) === 0 ? 0 : Number(p.k) || 1)), shares: {}, at: now() };
    for (const [flow, sh] of Object.entries(p.shares).slice(0, 40)) {
      if (!/^[a-z0-9_]{1,40}$/.test(flow) || !Array.isArray(sh)) continue;
      clean.shares[flow] = sh.slice(0, 12).map((x) => [String(x[0]).slice(0, 60), Number(x[1]) || 0]);
    }
    await L.setMeta("fee_plans", clean);
    return { ok: true };
  }));
  app.post("/api/escrow/admin/game-import", bot((b) => importGame(b)));
  app.post("/api/escrow/admin/game-export", bot((b) => exportGame(String(b.game || ""))));
  app.post("/api/escrow/admin/game-rollback", bot((b) => rollbackGame({ game: String(b.game || ""), key: b.key, actor: b.actor })));
}

module.exports = { register, act, tick, load, list, save, nextId, feeLegs, split, feePlans, gameLive, actorAccount, isWho, same, fromForm,
                   importGame, exportGame, rollbackGame, CMD_GAME, VAULT_DESTS, _forget: forget };
