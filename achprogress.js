// achprogress.js — Phase 5 (5.14) of the backend migration: the Camfrog achievement COUNTERS live on the site.
//
// Until now Pepe kept every counter in one bot file (achievements_progress.json, keyed by the lower-case Camfrog login:
// {login: {m: {metric: n}, got: [ids], cmds, day, streak, shop, kit, stk, store, ...}} + a few top-level backfill flags),
// decided when a threshold was crossed and called POST /api/g/achievement. After the cutover (docs/achievements-cutover-runbook.md)
// the site owns all of it:
//
//   ach_progress        login PK (Pepe's key: the lower-case Camfrog login, or "u:<userId>" - the login re-key's convention),
//                       extra (JSON: every field of the record except the counters - got, cmds, day, streak, shop, kit, ...)
//   ach_metrics         (login, metric) PK -> value (TEXT: an exact decimal - staging's sandbox numbers pass 2^53)
//   ach_events          key PK -> the result of one of Pepe's metric events (applied once; a retry answers the stored result)
//   ach_progress_meta   enabled / live / imported / flags (Pepe's top-level backfill flags) / rollbacks
//
// Pepe keeps OBSERVING Camfrog (chat, mic, cams, games, commands) and posts keyed events in batches (POST
// /api/achievements/bot/events, from his 30 s tick, on a worker). An event is one login's change since the last one:
//   {key, login, m: {metric: [from, to]}, set: {field: value|null}, got: [ids], check: [metrics], del, rekey: {old, new},
//    flag, value}
// The site applies it once (a counter whose value is still `from` becomes `to`; anything else gets the difference), then
// evaluates the thresholds of the metrics in `check` - exactly the metrics Pepe's own _ach_check would have looked at
// (a bump; never a backfill's direct write, so the quiet backfills stay quiet) - and awards through achievements.award:
// badge once per account (user_badges), XP, and the PAT through funding.fundPayout("achievements") (the incentive budget's
// achievements group; queued when it is short). The answer lists the loud awards; Pepe announces them in the room where
// the bump happened. Achievements held for a quiet backfill (`held`) are never awarded loudly.
//
// The switch (like the gangs): ach_progress_meta.enabled (default on on staging, off on prod) lets Pepe hand the counters
// over; "live" is set by the import and cleared by a rollback. Pepe's side: !achievements backend status|export|on|off|detach.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const KEY_RE = /^[A-Za-z0-9_.:@\-]{6,160}$/;
const LOGIN_RE = /^[^\u0000-\u001f"<>]{1,80}$/;
const METRIC_RE = /^[^\u0000-\u001f"<>]{1,80}$/;
const NUM_RE = /^-?\d{1,40}(\.\d{1,20})?$/;
// pepe_loginrekey.MAX_KEYS (1.99aco: + the duel / brawl win streaks - best run and current run - so two runs never add up)
const MAX_KEYS = new Set(["streak", "best", "level", "max", "best_streak", "peak", "deepest",
  "duel_streak", "brawl_streak", "duel_streak_run", "brawl_streak_run"]);
const MAX_BATCH = 500;
const MAX_EXTRA = 20000;

class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.extra = extra || null; }
}
const now = () => Date.now();
const J = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { if (s == null) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
const sha = (t) => crypto.createHash("sha256").update(String(t), "utf8").digest("hex");

// ── exact decimals (counters are integers; a float is tolerated and compared as a Number) ──
const isInt = (s) => /^-?\d+$/.test(String(s));
function dec(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Refuse(400, `bad number ${v}`);
    return Number.isInteger(v) ? BigInt(v).toString() : String(v);
  }
  const s = String(v == null ? "0" : v).trim();
  if (!NUM_RE.test(s)) throw new Refuse(400, `bad number ${s.slice(0, 40)}`);
  return isInt(s) ? BigInt(s).toString() : s;
}
const add = (a, b) => (isInt(a) && isInt(b) ? (BigInt(a) + BigInt(b)).toString() : String(Number(a) + Number(b)));
const sub = (a, b) => (isInt(a) && isInt(b) ? (BigInt(a) - BigInt(b)).toString() : String(Number(a) - Number(b)));
const cmp = (a, b) => {
  if (isInt(a) && isInt(b)) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  const x = Number(a), y = Number(b); return x < y ? -1 : x > y ? 1 : 0;
};
const maxDec = (a, b) => (cmp(a, b) >= 0 ? a : b);

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS ach_progress (
        login TEXT PRIMARY KEY, extra TEXT NOT NULL DEFAULT '{}', updated INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS ach_metrics (
        login TEXT NOT NULL, metric TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (login, metric))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS ach_events (
        key TEXT PRIMARY KEY, login TEXT, at INTEGER NOT NULL, state TEXT NOT NULL, result TEXT)`);
      await runQuery("CREATE TABLE IF NOT EXISTS ach_progress_meta (key TEXT PRIMARY KEY, value TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM ach_progress_meta WHERE key = ?", [key]))[0];
  return r ? parse(r.value, null) : null;
}
const setMeta = (key, v) => runQuery("INSERT INTO ach_progress_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                      [key, J(v)]);

/** May Pepe hand his counters over? Default: on on staging (STAGING env), off on prod until an admin turns it on. */
async function enabled() {
  const v = await meta("enabled");
  if (v === true || v === false) return v;
  return !!process.env.STAGING;
}
let liveCache = { at: 0, v: false };
/** The site owns the counters (an import ran and wasn't rolled back). Cached 2 s. */
async function live() {
  if (now() - liveCache.at < 2000) return liveCache.v;
  await init();
  const v = !!(await meta("live"));
  liveCache = { at: now(), v };
  return v;
}
const forgetLive = () => { liveCache = { at: 0, v: false }; };

// ── one record (Pepe's shape) ──
async function readRecord(login) {
  const p = (await getQuery("SELECT extra FROM ach_progress WHERE login = ?", [login]))[0];
  if (!p) return null;
  const rec = Object.assign({}, parse(p.extra, {}));
  rec.m = {};
  for (const r of await getQuery("SELECT metric, value FROM ach_metrics WHERE login = ? ORDER BY metric", [login])) rec.m[r.metric] = r.value;
  if (!Array.isArray(rec.got)) rec.got = [];
  return rec;
}
async function writeExtra(login, extra) {
  const s = J(extra);
  if (s.length > MAX_EXTRA) throw new Refuse(400, `record ${login} too large`);
  await runQuery(`INSERT INTO ach_progress (login, extra, updated) VALUES (?, ?, ?)
                  ON CONFLICT(login) DO UPDATE SET extra = excluded.extra, updated = excluded.updated`, [login, s, now()]);
}
const setMetric = (login, metric, value) => runQuery(`INSERT INTO ach_metrics (login, metric, value) VALUES (?, ?, ?)
                    ON CONFLICT(login, metric) DO UPDATE SET value = excluded.value`, [login, metric, value]);

/** The whole store in Pepe's file shape: {users: {login: {m: {metric: "n"}, ...}}, flags}. Values stay exact strings. */
async function exportObject() {
  await init();
  const users = {};
  for (const p of await getQuery("SELECT login, extra FROM ach_progress ORDER BY login")) {
    const rec = Object.assign({}, parse(p.extra, {}));
    rec.m = {};
    if (!Array.isArray(rec.got)) rec.got = [];
    users[p.login] = rec;
  }
  for (const r of await getQuery("SELECT login, metric, value FROM ach_metrics ORDER BY login, metric")) {
    if (users[r.login]) users[r.login].m[r.metric] = r.value;
  }
  return { v: 1, users, flags: (await meta("flags")) || {} };
}

/** Totals both sides compute the same way: users, unlocks (got ids), counter rows, the exact sum of every counter. */
function totalsOf(obj) {
  let users = 0, got = 0, metrics = 0, sum = "0";
  for (const rec of Object.values((obj && obj.users) || {})) {
    users++;
    got += Array.isArray(rec.got) ? rec.got.length : 0;
    for (const v of Object.values(rec.m || {})) { metrics++; sum = add(sum, dec(v)); }
  }
  return { users, got, metrics, value_sum: sum, flags: Object.keys((obj && obj.flags) || {}).length };
}
function sameTotals(a, b) {
  return a && b && Number(a.users) === Number(b.users) && Number(a.got) === Number(b.got) && Number(a.metrics) === Number(b.metrics)
         && String(a.value_sum) === String(b.value_sum) && Number(a.flags || 0) === Number(b.flags || 0);
}

// ── the cutover: import (idempotent, verifies itself, rolls back on any mismatch) ──
const backupDb = (tag) => require("./dbbackup").backupDb(tag);

function parseExport(text) {
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new Refuse(400, "payload is not JSON"); }
  if (!p || typeof p !== "object" || !p.users || typeof p.users !== "object") throw new Refuse(400, "payload has no users");
  const users = {};
  for (const [login0, rec] of Object.entries(p.users)) {
    const login = low(login0);
    if (!LOGIN_RE.test(login) || login !== login0) throw new Refuse(400, `bad login ${String(login0).slice(0, 40)}`);
    if (!rec || typeof rec !== "object" || !rec.m || typeof rec.m !== "object") throw new Refuse(400, `bad record ${login}`);
    const m = {};
    for (const [k, v] of Object.entries(rec.m)) {
      if (!METRIC_RE.test(k)) throw new Refuse(400, `bad metric ${String(k).slice(0, 40)} (${login})`);
      m[k] = dec(v);
    }
    const extra = Object.assign({}, rec);
    delete extra.m;
    if (!Array.isArray(extra.got)) extra.got = [];
    users[login] = { m, extra };
  }
  const flags = p.flags && typeof p.flags === "object" ? p.flags : {};
  return { users, flags };
}

/**
 * Pepe's export -> the tables, once. body: {key, payload (JSON text), digest (sha256 of payload), totals}. Checks: the switch
 * is on, nothing is live, the digest, the totals. Then a verified DB backup and ONE transaction: every record + counter + the
 * flags written, re-read and compared (users, unlocks, counter rows, the exact counter sum); live on. Any mismatch throws ->
 * the transaction rolls back -> ok:false. The same key again answers the stored result.
 */
async function importFromPepe(body) {
  await init();
  if (!(await enabled())) throw new Refuse(409, "the achievements backend is switched off on this site", "E_FEATURE_OFF");
  const key = String((body && body.key) || "");
  if (!KEY_RE.test(key)) throw new Refuse(400, "bad key");
  const payload = String((body && body.payload) || "");
  const digest = sha(payload);
  if (!payload || digest !== String(body.digest || "")) throw new Refuse(400, "digest mismatch", "E_DIGEST");
  const done = await meta("imported");
  if (done && done.key === key) {
    if (done.digest === digest) return Object.assign({ ok: true, already: true }, done.answer || {});
    throw new Refuse(409, "this cutover key was already used with a different export", "E_ALREADY");
  }
  if (await live()) throw new Refuse(409, "the site already owns the achievement counters (another import)", "E_ALREADY");
  const { users, flags } = parseExport(payload);
  const want = totalsOf({ users: Object.fromEntries(Object.entries(users).map(([l, u]) => [l, Object.assign({ m: u.m }, u.extra)])), flags });
  if (!sameTotals(want, body.totals)) {
    throw new Refuse(400, `totals don't match: ${J(want)} vs ${J(body.totals)}`, "E_TOTALS");
  }
  const backup = await backupDb("pre-achievements-import");
  let answer;
  try {
    answer = await tx(async () => {
      if (await meta("live")) throw new Refuse(409, "already imported", "E_ALREADY");      // lost a race with its twin
      await runQuery("DELETE FROM ach_metrics");
      await runQuery("DELETE FROM ach_progress");
      for (const login of Object.keys(users).sort()) {
        await writeExtra(login, users[login].extra);
        for (const [k, v] of Object.entries(users[login].m)) await setMetric(login, k, v);
      }
      await setMeta("flags", flags);
      const got = totalsOf(await exportObject());
      if (!sameTotals(got, want)) throw new Refuse(500, `re-read totals ${J(got)} != export ${J(want)}`, "E_VERIFY");
      // the unlock count per account, as the site sees it (for the runbook's check)
      const out = { key, digest, totals: got, match: true, backup, at: now() };
      await setMeta("live", true);
      await setMeta("imported", { key, digest, at: out.at, answer: out });
      return out;
    });
  } finally {
    forgetLive();
  }
  console.log(`[achievements] IMPORT ${key}: ${answer.totals.users} login(s), ${answer.totals.got} unlock(s), ${answer.totals.metrics} counter(s) (backup ${backup})`);
  return Object.assign({ ok: true }, answer);
}

/**
 * The way back (Pepe asks while the site answers): the whole store handed back as Pepe's file (exact text + sha256 + totals),
 * the tables emptied and live off, in one transaction, after a verified backup. The same key again answers the same text.
 */
async function rollbackToPepe({ key, actor } = {}) {
  await init();
  key = String(key || "");
  if (!KEY_RE.test(key)) throw new Refuse(400, "bad key");
  const prev = ((await meta("rollbacks")) || []).find((r) => r.key === key);
  if (prev && prev.answer) return Object.assign({ ok: true, already: true }, prev.answer);
  if (!(await live())) throw new Refuse(409, "the site doesn't own the achievement counters", "E_NOT_LIVE");
  const backup = await backupDb("pre-achievements-rollback");
  let out;
  try {
    out = await tx(async () => {
      if (!(await meta("live"))) throw new Refuse(409, "not live", "E_NOT_LIVE");
      const obj = await exportObject();
      const text = JSON.stringify(obj);
      const answer = { key, state: text, digest: sha(text), totals: totalsOf(obj), at: now() };
      await runQuery("DELETE FROM ach_metrics");
      await runQuery("DELETE FROM ach_progress");
      await setMeta("live", false);
      const list = ((await meta("rollbacks")) || []).slice(-9);
      list.push({ key, actor: String(actor || "").slice(0, 40), at: answer.at, backup, answer });
      await setMeta("rollbacks", list);
      return answer;
    });
  } finally {
    forgetLive();
  }
  console.log(`[achievements] ROLLBACK ${key}: ${out.totals.users} login(s), ${out.totals.got} unlock(s) handed back to Pepe (backup ${backup})`);
  return Object.assign({ ok: true }, out);
}

// ── re-keying a login (loginrekey.js calls it inside its transaction; Pepe's "rekey" event the same) ──
function mergeVal(a, b, key, archived, path) {
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (a === b) return a;
  } else if (typeof a === "number" && typeof b === "number") {
    return MAX_KEYS.has(key) ? Math.max(a, b) : a + b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set(a.map((x) => J(x)));
    return a.concat(b.filter((x) => !seen.has(J(x))));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const [k, v] of Object.entries(b)) a[k] = Object.prototype.hasOwnProperty.call(a, k) ? mergeVal(a[k], v, k, archived, `${path}.${k}`) : v;
    return a;
  }
  if (J(a) === J(b)) return a;
  archived.push({ path, value: b });
  return a;
}

/** Move one login's record to its new key (merging like Pepe: counters add up, streak-like keep the larger, lists union). */
async function rekeyInTx(oldKey, newKey, archive) {
  await init();
  const old = low(oldKey), nw = low(newKey);
  const log = [];
  if (!old || !nw || old === nw) return log;
  const from = await readRecord(old);
  if (!from) return log;
  const LR = require("./loginrekey");
  const fixed = LR.rekeyValue(Object.assign({}, from, { m: undefined }), old, nw, { n: 0, archived: [] });
  delete fixed.m;
  const there = await readRecord(nw);
  const archived = [];
  let extra = fixed;
  const metrics = Object.assign({}, from.m);
  if (there) {
    const tm = there.m;
    delete there.m;
    extra = mergeVal(there, fixed, null, archived, nw);
    for (const [k, v] of Object.entries(tm)) metrics[k] = Object.prototype.hasOwnProperty.call(metrics, k) ? (MAX_KEYS.has(k) ? maxDec(metrics[k], v) : add(metrics[k], v)) : v;
  }
  await writeExtra(nw, extra);
  for (const [k, v] of Object.entries(metrics)) await setMetric(nw, k, v);
  await runQuery("DELETE FROM ach_metrics WHERE login = ?", [old]);
  await runQuery("DELETE FROM ach_progress WHERE login = ?", [old]);
  log.push({ table: "ach_progress", action: there ? "merged" : "moved", from: old, to: nw });
  if (archive) for (const a of archived) await archive("ach_progress", `${nw}${a.path}`, a.value);
  return log;
}

// ── Pepe's metric events ──
let chain = Promise.resolve();
function serial(fn) {            // one batch at a time (the counters' compare-and-set and the awards stay in order)
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

function cleanEvent(ev) {
  if (!ev || typeof ev !== "object") throw new Refuse(400, "bad event");
  const key = String(ev.key || "");
  if (!KEY_RE.test(key)) throw new Refuse(400, `bad event key ${key.slice(0, 40)}`);
  const out = { key };
  if (ev.flag !== undefined) {
    const f = String(ev.flag);
    if (!METRIC_RE.test(f)) throw new Refuse(400, "bad flag");
    return Object.assign(out, { flag: f, value: ev.value === undefined ? null : ev.value });
  }
  if (ev.rekey) {
    const o = low(ev.rekey.old), n = low(ev.rekey.new);
    if (!LOGIN_RE.test(o) || !LOGIN_RE.test(n)) throw new Refuse(400, "bad rekey");
    return Object.assign(out, { rekey: { old: o, new: n } });
  }
  const login = low(ev.login);
  if (!LOGIN_RE.test(login)) throw new Refuse(400, "bad login");
  out.login = login;
  if (ev.del) return Object.assign(out, { del: true });
  out.m = {};
  for (const [k, pair] of Object.entries(ev.m || {})) {
    if (!METRIC_RE.test(k) || !Array.isArray(pair) || pair.length !== 2) throw new Refuse(400, `bad counter ${String(k).slice(0, 40)}`);
    out.m[k] = [dec(pair[0]), dec(pair[1])];
  }
  out.set = {};
  for (const [k, v] of Object.entries(ev.set || {})) {
    if (k === "m" || k === "got" || !METRIC_RE.test(k)) throw new Refuse(400, `bad field ${String(k).slice(0, 40)}`);
    out.set[k] = v === undefined ? null : v;
  }
  out.got = (Array.isArray(ev.got) ? ev.got : []).map(String).filter((x) => METRIC_RE.test(x)).slice(0, 300);
  out.check = (Array.isArray(ev.check) ? ev.check : []).map(String).filter((x) => METRIC_RE.test(x)).slice(0, 300);
  return out;
}

/** Apply one event's counters / fields (inside a transaction). -> {diverged} */
async function applyCounters(ev) {
  let diverged = 0;
  if (ev.flag !== undefined) {
    const flags = (await meta("flags")) || {};
    if (ev.value === null) delete flags[ev.flag]; else flags[ev.flag] = ev.value;
    await setMeta("flags", flags);
    return { diverged };
  }
  if (ev.rekey) {
    const LR = require("./loginrekey");
    await LR.ensure();
    const archive = async (tbl, recKey, data) => runQuery("INSERT INTO login_rekey_archive (change_id, tbl, rec_key, data, at) VALUES (?, ?, ?, ?, ?)",
      [null, tbl, recKey, typeof data === "string" ? data : J(data), now()]);
    const log = await rekeyInTx(ev.rekey.old, ev.rekey.new, archive);
    return { diverged, rekey: log.length };
  }
  if (ev.del) {
    await runQuery("DELETE FROM ach_metrics WHERE login = ?", [ev.login]);
    await runQuery("DELETE FROM ach_progress WHERE login = ?", [ev.login]);
    return { diverged };
  }
  const cur = (await readRecord(ev.login)) || { m: {}, got: [] };
  for (const [k, [from, to]] of Object.entries(ev.m)) {
    const c = Object.prototype.hasOwnProperty.call(cur.m, k) ? cur.m[k] : "0";
    let v;
    if (cmp(c, from) === 0 || cmp(c, to) === 0) v = to;
    else { v = add(c, sub(to, from)); diverged++; }
    await setMetric(ev.login, k, v);
    cur.m[k] = v;
  }
  const extra = Object.assign({}, cur);
  delete extra.m;
  for (const [k, v] of Object.entries(ev.set)) { if (v === null) delete extra[k]; else extra[k] = v; }
  const got = Array.isArray(extra.got) ? extra.got.slice() : [];
  for (const id of ev.got) if (!got.includes(id)) got.push(id);
  extra.got = got;
  await writeExtra(ev.login, extra);
  if (diverged) console.log(`[achievements] ${ev.key} ${ev.login}: ${diverged} counter(s) differed from Pepe's base - the difference was applied`);
  return { diverged };
}

/** The awards an event's checked metrics have earned (outside the counters' transaction: a payout is its own). */
async function evaluate(ev, held) {
  const A = require("./achievements");
  const rec = await readRecord(ev.login);
  if (!rec) return [];
  const out = [];
  const byMetric = {};
  for (const a of A.list()) if (a.side !== "web") (byMetric[a.metric] = byMetric[a.metric] || []).push(a);
  for (const metric of ev.check) {
    const val = Object.prototype.hasOwnProperty.call(rec.m, metric) ? rec.m[metric] : "0";
    for (const a of byMetric[metric] || []) {
      if (rec.got.includes(a.id) || held.has(a.id) || cmp(val, dec(a.threshold || 1)) < 0) continue;
      const r = await A.awardLogin(ev.login, a.id);
      if (!r.ok) { out.push({ id: a.id, ok: false, error: r.error || "refused" }); continue; }
      rec.got.push(a.id);
      await tx(async () => {
        const now2 = await readRecord(ev.login);
        if (!now2) return;
        const extra = Object.assign({}, now2);
        delete extra.m;
        if (!extra.got.includes(a.id)) extra.got.push(a.id);
        await writeExtra(ev.login, extra);
      });
      out.push({ id: a.id, ok: true, awarded: !!r.awarded, already: !!r.already, name: a.name, emoji: a.emoji, desc: a.desc, tier: a.tier,
                 xp: r.xp || 0, pat: r.pat || 0, patPaid: !!r.patPaid, patQueued: !!r.patQueued });
    }
  }
  return out;
}

/** POST /api/achievements/bot/events {events, held} -> {ok, results: {key: {...}}}. Each key once; a retry answers the same. */
async function applyEvents(events, held) {
  await init();
  if (!(await live())) throw new Refuse(409, "the site doesn't own the achievement counters", "E_NOT_LIVE");
  if (!Array.isArray(events) || events.length > MAX_BATCH) throw new Refuse(400, `events: an array of at most ${MAX_BATCH}`);
  const clean = events.map(cleanEvent);
  const heldSet = new Set((Array.isArray(held) ? held : []).map(String));
  return serial(async () => {
    const results = {};
    for (const ev of clean) {
      const row = (await getQuery("SELECT state, result FROM ach_events WHERE key = ?", [ev.key]))[0];
      if (row && row.state === "done") { results[ev.key] = Object.assign(parse(row.result, {}), { replay: true }); continue; }
      let res = row ? parse(row.result, {}) : null;
      if (!row) {
        res = await tx(async () => {
          if (!(await meta("live"))) throw new Refuse(409, "not live", "E_NOT_LIVE");
          const r = await applyCounters(ev);
          await runQuery("INSERT INTO ach_events (key, login, at, state, result) VALUES (?, ?, ?, 'applied', ?)",
                         [ev.key, ev.login || null, now(), J(r)]);
          return r;
        });
      }
      if (ev.login && !ev.del && ev.check && ev.check.length) {
        const awards = await evaluate(ev, heldSet);
        res.awards = awards.filter((a) => a.ok && a.awarded);
        res.failed = awards.filter((a) => !a.ok).map((a) => a.id);
        const got = (await readRecord(ev.login) || { got: [] }).got;
        res.got = awards.filter((a) => a.ok).map((a) => a.id).filter((id) => got.includes(id));
      }
      await runQuery("UPDATE ach_events SET state = 'done', result = ? WHERE key = ?", [J(res), ev.key]);
      results[ev.key] = res;
    }
    return { ok: true, results };
  });
}

// ── Pepe's achievement backfills while the site owns the counters (/api/g/achievement keeps their unlock in the record) ──
async function noteAward(login, badgeId) {
  if (!login || !(await live())) return;
  login = low(login);
  await tx(async () => {
    const rec = await readRecord(login);
    if (!rec) return;
    const extra = Object.assign({}, rec);
    delete extra.m;
    if (extra.got.includes(badgeId)) return;
    extra.got.push(badgeId);
    await writeExtra(login, extra);
  }).catch((e) => console.error("[achievements] noteAward:", e.message));
}

async function status() {
  await init();
  const n = (await getQuery("SELECT COUNT(*) AS n FROM ach_progress"))[0].n;
  const e = (await getQuery("SELECT COUNT(*) AS n, MAX(at) AS last FROM ach_events"))[0];
  const imp = await meta("imported");
  return { enabled: await enabled(), live: await live(), imported: imp ? { key: imp.key, at: imp.at, totals: (imp.answer || {}).totals } : null,
           logins: n, events: e.n, last_event: e.last, rollbacks: ((await meta("rollbacks")) || []).map((r) => ({ key: r.key, at: r.at, actor: r.actor })) };
}

/** A person's counters for the website (their linked login, or u:<id>). */
async function progressFor(userId) {
  await init();
  const u = (await getQuery("SELECT userId, camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  if (!u) return null;
  const login = low(u.camfrogUsername) || `u:${u.userId}`;
  const rec = await readRecord(login);
  return rec ? { login, m: rec.m } : { login, m: {} };
}

function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[achievements] progress init:", e.message));
  const send = (res, e, tag) => {
    if (e instanceof Refuse) return res.status(e.status).json(Object.assign({ ok: false, error: e.message, code: e.code }, e.extra || {}));
    console.error(`[achievements] ${tag}:`, e);
    res.status(500).json({ ok: false, error: "server_error" });
  };
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) { send(res, e, "bot"); }
  };
  app.post("/api/achievements/bot/status", bot(async () => Object.assign({ ok: true }, await status())));
  app.post("/api/achievements/bot/state", bot(async () => {
    if (!(await live())) return { ok: true, live: false, enabled: await enabled() };
    const obj = await exportObject();
    return { ok: true, live: true, enabled: await enabled(), state: obj, totals: totalsOf(obj) };
  }));
  app.post("/api/achievements/bot/events", require("express").json({ limit: "4mb" }), bot((b) => applyEvents(b.events, b.held)));
  // the export can exceed the global 100 KB JSON limit (index.js skips these paths)
  app.post("/api/achievements/admin/import", require("express").json({ limit: "32mb" }), bot((b) => importFromPepe(b)));
  app.post("/api/achievements/admin/rollback", bot((b) => rollbackToPepe({ key: b.key, actor: b.actor })));

  app.get("/api/achievements/progress", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(req.user && req.user.userId)) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      if (!(await live())) return res.json({ ok: true, live: false });
      res.json(Object.assign({ ok: true, live: true }, await progressFor(req.user.userId)));
    } catch (e) { send(res, e, "progress"); }
  });

  const admin = async (req, res) => {
    const uid = req.user && req.user.userId;
    if (!uid) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await getQuery("SELECT class, username FROM users WHERE userId = ?", [uid]).catch(() => []))[0];
    if (!SP.can(row, "econ.backend_cutover")) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    return row;
  };
  app.get("/api/admin/achievements-backend", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(await admin(req, res))) return;
    try { res.json(Object.assign({ ok: true }, await status(), { totals: totalsOf(await exportObject()) })); } catch (e) { send(res, e, "admin"); }
  });
  app.post("/api/admin/achievements-backend", addUser, async (req, res) => {
    const me = await admin(req, res);
    if (!me) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    if (await live()) return res.status(409).json({ ok: false, error: "The site owns the counters now - roll back from Pepe (docs/achievements-cutover-runbook.md)." });
    await setMeta("enabled", !!(req.body || {}).on);
    await setMeta("enabled_by", { by: me.username, at: now(), on: !!(req.body || {}).on });
    console.log(`[achievements] backend switch ${(req.body || {}).on ? "ON" : "OFF"} by ${me.username}`);
    res.json({ ok: true, enabled: await enabled() });
  });
}

module.exports = { init, register, enabled, live, meta, setMeta, exportObject, totalsOf, sameTotals, importFromPepe, rollbackToPepe,
                   applyEvents, rekeyInTx, noteAward, status, progressFor, readRecord, Refuse, dec, add, cmp,
                   _forgetLive: forgetLive };
