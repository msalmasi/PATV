// gtfstore.js — 1.99nq: Grand Theft Frogger's persistent data on the site, behind a GTF backend switch; Pepe is a client.
//
// What lives here once the backend is live (Pepe keeps the heist and invasion ENGINES - he rolls the dice and decides
// every outcome; this is where the results are kept):
//
//   gtf_records   (kind, id) -> data (JSON), rev, deleted, updated
//                   kind "sheet" = one heist character sheet (Pepe's heist_data.json entry: stats, class, heist stats -
//                                  heists / busts / loot / cracks / deepest, the loadout - items + gear, the avatar seed,
//                                  heat, rings, brawl / arena wins and losses)
//                   kind "pvp"   = one player's duel record (Pepe's duel_records.json entry: wins / losses / net)
//                   kind "lore"  = id "cracks": the recent vault cracks list (heist_lore.json)
//   gtf_batches   key PRIMARY KEY             every write batch Pepe sends, idempotent by key (a retry gets the first answer)
//   gtf_meta      enabled / imported / released / rev
//
// NOT here (on purpose): gangs, turf, gang treasuries and the money pools - other systems own those.
//
// The switch (same model as the casino and the stashes): the backend is `enabled` here (default ON on staging, OFF on prod
// until an admin turns it on: tools/gtf-backend.js or POST /api/admin/gtf-backend) AND an admin tells Pepe
// `!gtf backend on`. Then Pepe freezes the GTF commands, waits for any heist / arena / fight to end, exports
// heist_data.json + duel_records.json + heist_lore.json with a sha256 and totals and posts it (POST /api/gtf/bot/import).
// The import takes a verified SQLite backup first, checks the digest and the totals, writes everything in one transaction
// and checks the totals again from the tables; it is idempotent (the same export answers "already", a different one is
// refused while live). Pepe then switches to client mode: his files are a local MIRROR, every change he makes is sent
// as a keyed batch (/api/gtf/bot/put), and at start he pulls what changed (/api/gtf/bot/state).
//
// The way back (`!gtf backend off`): Pepe flushes his last changes, asks for the release (POST /api/gtf/bot/release):
// the site freezes its copy (no more writes), answers the full export (same shape, sha256, totals) and Pepe writes it back
// into his local files (keeping a .pre-local backup of the mirror). The rows stay here as an archive until the next
// import, which replaces them (after a fresh backup). docs/gtf-backend.md has the runbook.
"use strict";
const crypto = require("crypto");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");

const KINDS = new Set(["sheet", "pvp", "lore"]);
const KEY_RE = /^[A-Za-z0-9_.:@-]{6,160}$/;
const MAX_BATCH = 500;

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}
const now = () => Date.now();
const okId = (id) => typeof id === "string" && id.length >= 1 && id.length <= 120 && !/[\u0000-\u001f]/.test(id);

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS gtf_records (
        kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT, rev INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
        updated INTEGER, PRIMARY KEY (kind, id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS gtf_records_rev ON gtf_records (rev)");
      await runQuery("CREATE TABLE IF NOT EXISTS gtf_batches (key TEXT PRIMARY KEY, ts INTEGER NOT NULL, n INTEGER, result TEXT)");
      await runQuery("CREATE TABLE IF NOT EXISTS gtf_meta (key TEXT PRIMARY KEY, value TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM gtf_meta WHERE key = ?", [key]))[0];
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
const setMeta = (key, v) => runQuery(`INSERT INTO gtf_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                                      [key, JSON.stringify(v)]);
const delMeta = (key) => runQuery("DELETE FROM gtf_meta WHERE key = ?", [key]);

/** May Pepe hand GTF's data over? Default: on on staging (STAGING env), off on prod until an admin turns it on. */
async function enabled() {
  const v = await meta("enabled");
  if (v === true || v === false) return v;
  return !!process.env.STAGING;
}
/** The site owns GTF's data (imported and not released back to Pepe). */
async function live() {
  return !!(await meta("imported")) && !(await meta("released"));
}
async function status() {
  return { ok: true, enabled: await enabled(), live: await live(), imported: await meta("imported"), released: await meta("released"),
           rev: (await meta("rev")) || 0 };
}

// one write at a time on the shared connection (mainstage's chain, like the stashes)
const tx = (fn) => require("./mainstage")._tx(fn);

// ── the export shape (Pepe's three files) ──
// Records travel and are stored as Pepe's own JSON TEXT, never re-serialized by JS: his numbers can pass 2^53 (staging's
// sandbox loot sums ~2.9e16), which a JS number can't hold - a parse + stringify would quietly change them. The totals
// are exact decimal strings (BigInt), read straight from that text.
const TOTAL_KEYS = ["sheets", "pvp", "lore", "loot", "heists", "duel_wins", "duel_losses"];

/** The top-level numbers `keys` of one JSON object's text, as BigInt (a float truncates, like Python's int()). */
function topInts(text, keys) {
  const want = new Set(keys), out = {};
  let depth = 0, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const raw = text.slice(i, j + 1);
      i = j + 1;
      if (depth === 1) {
        let k = i;
        while (text[k] === " " || text[k] === "\n" || text[k] === "\t" || text[k] === "\r") k++;
        if (text[k] === ":") {
          let m = k + 1;
          while (text[m] === " " || text[m] === "\n" || text[m] === "\t" || text[m] === "\r") m++;
          const mm = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(m, m + 64));
          let key = null;
          try { key = JSON.parse(raw); } catch (e) { key = null; }
          if (mm && want.has(key)) {
            out[key] = /[.eE]/.test(mm[0]) ? BigInt(Math.trunc(Number(mm[0]))) : BigInt(mm[0]);
          }
        }
      }
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return out;
}

const isObjText = (t) => {
  if (typeof t !== "string" || t.length > 2e6) return false;
  try { const v = JSON.parse(t); return !!v && typeof v === "object" && !Array.isArray(v); } catch (e) { return false; }
};
const isListText = (t) => {
  if (typeof t !== "string" || t.length > 2e6) return false;
  try { return Array.isArray(JSON.parse(t)); } catch (e) { return false; }
};

/** {v, sheets: {id: text}, pvp: {id: text}, lore: text} -> checked. */
function cleanExport(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Refuse(400, "payload must be an object");
  const sheets = obj.sheets && typeof obj.sheets === "object" && !Array.isArray(obj.sheets) ? obj.sheets : null;
  const pvp = obj.pvp && typeof obj.pvp === "object" && !Array.isArray(obj.pvp) ? obj.pvp : null;
  if (!sheets || !pvp || !isListText(obj.lore)) throw new Refuse(400, "payload needs sheets, pvp and lore (as JSON text)");
  for (const [id, t] of Object.entries(sheets)) if (!okId(id) || !isObjText(t)) throw new Refuse(400, `sheet ${String(id).slice(0, 40)}: bad`);
  for (const [id, t] of Object.entries(pvp)) if (!okId(id) || !isObjText(t)) throw new Refuse(400, `pvp ${String(id).slice(0, 40)}: bad`);
  return { sheets, pvp, lore: obj.lore };
}
/** Exact totals (decimal strings) of an export object of texts. */
function totalsOf({ sheets, pvp, lore }) {
  const t = { sheets: 0n, pvp: 0n, lore: 0n, loot: 0n, heists: 0n, duel_wins: 0n, duel_losses: 0n };
  try { t.lore = BigInt((JSON.parse(lore || "[]") || []).length); } catch (e) { t.lore = 0n; }
  for (const text of Object.values(sheets)) {
    const v = topInts(text, ["loot", "heists"]);
    t.sheets++; t.loot += v.loot || 0n; t.heists += v.heists || 0n;
  }
  for (const text of Object.values(pvp)) {
    const v = topInts(text, ["wins", "losses"]);
    t.pvp++; t.duel_wins += v.wins || 0n; t.duel_losses += v.losses || 0n;
  }
  return Object.fromEntries(TOTAL_KEYS.map((k) => [k, t[k].toString()]));
}
const sameTotals = (a, b) => TOTAL_KEYS.every((k) => String((a || {})[k]) === String((b || {})[k]));

/** The tables as the export object (live rows only; texts as stored). */
async function exportObject() {
  const rows = await getQuery("SELECT kind, id, data FROM gtf_records WHERE deleted = 0 ORDER BY kind, id");
  const out = { v: 1, sheets: {}, pvp: {}, lore: "[]" };
  for (const r of rows) {
    if (r.kind === "sheet") out.sheets[r.id] = r.data;
    else if (r.kind === "pvp") out.pvp[r.id] = r.data;
    else if (r.kind === "lore" && r.id === "cracks") out.lore = r.data;
  }
  return out;
}

const backupDb = (tag) => require("./dbbackup").backupDb(tag);   // the online backup API, verified - never a file copy

/**
 * Pepe's export -> the tables. body: {payload: JSON text of the export object, digest: sha256(payload), totals}.
 * -> {ok, already?, totals, backup}. Refused unless enabled, the digest matches and the totals add up.
 */
async function importFromPepe(body) {
  await init();
  if (!(await enabled())) throw new Refuse(409, "the GTF backend is switched off on this site", "E_FEATURE_OFF");
  const payload = String((body && body.payload) || "");
  const digest = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  if (!payload || digest !== String(body.digest || "")) throw new Refuse(400, "digest mismatch");
  const done = await meta("imported");
  const released = await meta("released");
  if (done && !released) {
    if (done.digest === digest) return { ok: true, already: true, totals: done.totals, backup: done.backup || null };
    throw new Refuse(409, "GTF data was already imported from a different export", "E_ALREADY");
  }
  let obj;
  try { obj = cleanExport(JSON.parse(payload)); } catch (e) { throw e instanceof Refuse ? e : new Refuse(400, "payload is not JSON"); }
  const totals = totalsOf(obj);
  if (!sameTotals(totals, body.totals)) {
    throw new Refuse(400, `totals don't match: ${JSON.stringify(totals)} vs ${JSON.stringify(body.totals || {})}`);
  }
  const backup = await backupDb("pre-gtf-import");
  await tx(async () => {
    if ((await meta("imported")) && !(await meta("released"))) throw new Refuse(409, "already imported");     // lost a race with its twin
    await runQuery("DELETE FROM gtf_records");          // a released archive (it is in the backup just taken)
    let rev = (await meta("rev")) || 0;
    const ins = (kind, id, text) => runQuery("INSERT INTO gtf_records (kind, id, data, rev, deleted, updated) VALUES (?, ?, ?, ?, 0, ?)",
                                             [kind, id, text, ++rev, now()]);
    for (const [id, s] of Object.entries(obj.sheets)) await ins("sheet", id, s);
    for (const [id, r] of Object.entries(obj.pvp)) await ins("pvp", id, r);
    await ins("lore", "cracks", obj.lore);
    const check = totalsOf(await exportObject());
    if (!sameTotals(check, totals)) throw new Refuse(500, "the imported totals didn't verify - rolled back");
    await setMeta("rev", rev);
    await setMeta("imported", { at: now(), digest, totals, backup });
    await delMeta("released");
  });
  await syncAvatarSeeds(obj.sheets).catch(() => {});
  console.log(`[gtf] imported ${totals.sheets} sheet(s), ${totals.pvp} pvp record(s), ${totals.lore} crack(s) from Pepe (backup ${backup})`);
  return { ok: true, totals, backup };
}

async function requireLive() {
  if (!(await live())) throw new Refuse(409, "GTF data lives in Pepe right now", "E_NOT_LIVE");
}

/**
 * Pepe's changes: body {key, records: [{kind, id, json}]} (json = the record's JSON text; null = removed). One transaction,
 * idempotent by key. -> {ok, rev, n} (dup: true for a batch seen before).
 */
async function put(body) {
  await requireLive();
  const key = String((body && body.key) || "");
  if (!KEY_RE.test(key)) throw new Refuse(400, "Bad request (key).");
  const recs = Array.isArray(body.records) ? body.records : null;
  if (!recs || recs.length > MAX_BATCH) throw new Refuse(400, `records: 1-${MAX_BATCH} per batch`);
  for (const r of recs) {
    if (!r || !KINDS.has(r.kind) || !okId(r.id)) throw new Refuse(400, "bad record (kind / id)");
    if (r.kind === "lore" && r.id !== "cracks") throw new Refuse(400, "lore id must be cracks");
    if (r.json !== null && !(r.kind === "lore" ? isListText(r.json) : isObjText(r.json))) throw new Refuse(400, `bad json for ${r.kind} ${r.id}`);
  }
  const sheets = {};
  const out = await tx(async () => {
    const seen = (await getQuery("SELECT result FROM gtf_batches WHERE key = ?", [key]))[0];
    if (seen) {
      try { return Object.assign(JSON.parse(seen.result || "{}"), { dup: true }); } catch (e) { return { ok: true, dup: true }; }
    }
    let rev = (await meta("rev")) || 0;
    for (const r of recs) {
      rev++;
      if (r.json === null) {
        await runQuery(`INSERT INTO gtf_records (kind, id, data, rev, deleted, updated) VALUES (?, ?, NULL, ?, 1, ?)
                        ON CONFLICT(kind, id) DO UPDATE SET data = NULL, rev = excluded.rev, deleted = 1, updated = excluded.updated`,
                       [r.kind, r.id, rev, now()]);
      } else {
        await runQuery(`INSERT INTO gtf_records (kind, id, data, rev, deleted, updated) VALUES (?, ?, ?, ?, 0, ?)
                        ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, rev = excluded.rev, deleted = 0, updated = excluded.updated`,
                       [r.kind, r.id, r.json, rev, now()]);
        if (r.kind === "sheet") sheets[r.id] = r.json;
      }
    }
    await setMeta("rev", rev);
    const res = { ok: true, rev, n: recs.length };
    await runQuery("INSERT INTO gtf_batches (key, ts, n, result) VALUES (?, ?, ?, ?)", [key, now(), recs.length, JSON.stringify(res)]);
    return res;
  });
  if (!out.dup) syncAvatarSeeds(sheets).catch(() => {});
  // keep the batch log short: 14 days is plenty for a retry
  if (Math.random() < 0.02) runQuery("DELETE FROM gtf_batches WHERE ts < ?", [now() - 14 * 86400e3]).catch(() => {});
  return out;
}

/** What changed after `since` (rev), oldest first, at most `limit`. -> {ok, live, rev, records, more} */
async function stateSince(since, limit = 1000) {
  await init();
  const lim = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 1000)));
  const s = Math.max(0, Math.floor(Number(since) || 0));
  const rows = await getQuery("SELECT kind, id, data, rev, deleted FROM gtf_records WHERE rev > ? ORDER BY rev LIMIT ?", [s, lim + 1]);
  const more = rows.length > lim;
  const records = rows.slice(0, lim).map((r) => ({ kind: r.kind, id: r.id, rev: r.rev, json: r.deleted ? null : r.data }));
  return { ok: true, live: await live(), rev: (await meta("rev")) || 0, records, more };
}

/** The way back: freeze the site's copy and hand Pepe the full export. Idempotent (released again = the same export). */
async function release(body) {
  await init();
  const imported = await meta("imported");
  if (!imported) throw new Refuse(409, "nothing to release - GTF data was never imported here", "E_NOT_LIVE");
  let rel = await meta("released");
  if (!rel) {
    await tx(async () => {
      if (await meta("released")) return;
      await setMeta("released", { at: now(), by: String((body && body.by) || "pepe").slice(0, 60) });
    });
    rel = await meta("released");
  }
  const obj = await exportObject();
  const payload = JSON.stringify(obj);
  const digest = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  const totals = totalsOf(obj);
  if (!rel.digest) {
    rel = Object.assign({}, rel, { digest, totals });
    await setMeta("released", rel);
  }
  console.log(`[gtf] released ${totals.sheets} sheet(s) / ${totals.pvp} pvp record(s) back to Pepe (sha256 ${digest.slice(0, 12)})`);
  return { ok: true, payload, digest, totals, released: rel };
}

// the website's GTF avatars (cosmetic_avatar_seeds, normally fed by Pepe's userstats sync) follow the sheets right away
async function syncAvatarSeeds(sheets) {
  const rows = Object.entries(sheets || {}).map(([id, t]) => [id, (() => { try { return JSON.parse(t); } catch (e) { return null; } })()])
    .filter(([, s]) => s && Number.isSafeInteger(Number(s.avatar_seed)) && Number(s.avatar_seed) > 0);
  if (!rows.length) return;
  await runQuery("CREATE TABLE IF NOT EXISTS cosmetic_avatar_seeds (camfrog TEXT PRIMARY KEY, seed INTEGER, updated INTEGER)");
  for (const [id, s] of rows) {
    await runQuery(`INSERT INTO cosmetic_avatar_seeds (camfrog, seed, updated) VALUES (LOWER(?), ?, ?)
                    ON CONFLICT(camfrog) DO UPDATE SET seed = excluded.seed, updated = excluded.updated`, [id, Number(s.avatar_seed), now()]);
  }
}

// ── reads for the website ──
async function record(kind, id) {
  await init();
  const r = (await getQuery("SELECT data FROM gtf_records WHERE kind = ? AND id = ? AND deleted = 0", [kind, String(id || "").toLowerCase()]))[0];
  if (!r) return null;
  try { return JSON.parse(r.data); } catch (e) { return null; }
}
/** A player's heist sheet (null unless the site owns GTF's data). */
async function sheetOf(login) {
  if (!login || !(await live())) return null;
  return record("sheet", login);
}

/** Heist-shop spend per Camfrog login from the wallet ledger (Pepe's quiet backfill of the shop achievements). */
async function shopHistory() {
  const rows = await getQuery(`SELECT LOWER(u.camfrogUsername) AS login, COUNT(*) AS buys, -SUM(t.points) AS spent
                               FROM transactions t JOIN users u ON u.userId = t.userId
                               WHERE t.type = 'heist-gear' AND t.points < 0 AND u.camfrogUsername IS NOT NULL AND u.camfrogUsername != ''
                               GROUP BY LOWER(u.camfrogUsername)`);
  return rows.map((r) => ({ login: r.login, buys: Number(r.buys) || 0, spent: Number(r.spent) || 0 }));
}

// ── routes ──
function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[gtf] init:", e.message));
  const big = express.json({ limit: "32mb" });
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (e instanceof Refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      console.error("[gtf] bot:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  // POST so the staging router falls back to Pepe's sandbox when the staging site is down
  app.post("/api/gtf/bot/status", bot(() => status()));
  app.post("/api/gtf/bot/import", big, bot((b) => importFromPepe(b)));
  app.post("/api/gtf/bot/put", big, bot((b) => put(b)));
  app.post("/api/gtf/bot/state", bot((b) => stateSince(b.since_rev, b.limit)));
  app.post("/api/gtf/bot/release", bot((b) => release(b)));
  app.post("/api/gtf/bot/shop-history", bot(async () => ({ ok: true, rows: await shopHistory() })));
  // admins: switch the backend on/off (it gates the import; after it, Pepe's `!gtf backend off` is the way back)
  app.post("/api/admin/gtf-backend", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!row || row.class !== "Admin") return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    await init();
    await setMeta("enabled", !!(req.body || {}).on);
    res.json(await status());
  });
}

module.exports = { init, register, enabled, live, status, importFromPepe, put, stateSince, release, exportObject, totalsOf, topInts, sheetOf, record,
                   shopHistory, setMeta, meta, Refuse };
