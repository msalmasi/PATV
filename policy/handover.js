// policy/handover.js — PO-2 of the economy policy -> site plan ("Phase 6", plan sections 5 and 6.2): the site's half of a policy
// feature's HAND-OVER from Pepe (H1 = the config: policy_ownership.cfg pepe -> site). Pepe drives it (PO-3: `!econ policy
// freeze|export|cutover|rollback cfg confirm`, a Pepe owner by role); every step is a bot-token call that names the actor, and the
// site checks that actor holds Pepe's owner role HERE (the pinned owner list, PO-0b) - never Telegram.
//
//   POST /api/policy/bot/handover/freeze   {feature, actor, on}     pepe -> cutting (frozen: the mirror stops, every edit is 423)
//                                                                   / back (on: false)
//   POST /api/policy/bot/handover/begin    {feature, key, size, chunks, actor}   key = sha256 of the export (hex); needs "cutting"
//   POST /api/policy/bot/handover/chunk    {key, idx, data}         data = base64 of bytes [idx x chunk size ..); its own body limit
//                                                                   (index.js skips it: the 100 KB parser trap behind the 1,913
//                                                                   PayloadTooLarge errors); the same chunk again is a no-op
//   POST /api/policy/bot/handover/commit   {key, actor}             the chunks joined, sha256 checked (a mismatch is refused and
//                                                                   the chunks dropped), the payload checked (every SPEC key, each
//                                                                   valid, the whole config valid), then ONE dbUtils.tx: policy_cfg
//                                                                   (via "import"), Pepe's change log (original ts / who), his
//                                                                   ceiling log -> capital_ceil_log, the verify record. The money
//                                                                   tables are counted before and after INSIDE it: an import that
//                                                                   would write one money row rolls back. A rerun answers dup.
//   POST /api/policy/bot/handover/verify   {key}                    the verify record + a live recheck (per-key equality, digests)
//   POST /api/policy/bot/handover/cutover  {feature, key, actor}    cutting -> site, only with that key imported and still equal
//   POST /api/policy/bot/handover/rollback {feature, actor}         site -> pepe (refused while an engine is live or the budget is
//                                                                   the site's: roll back in reverse order) -> the site's values +
//                                                                   its change log since the flip, for Pepe to write back
// The cfg export (Pepe, PO-3): {v: 1, feature: "cfg", at, by, bot_version, cfg: {every SPEC key: its stored value}, log: [{ts, by,
// via, key, old, new}], ceil_log: [{ts, ceil_apr, ceil_cushion, ceil_cushion_days}], archive: {...the dead knobs, D-9}}.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("../dbUtils");
const S = require("./cfgspec");
const C = require("./core");

const KEY_RE = /^[0-9a-f]{64}$/;
const CHUNK_MAX = 512 * 1024;             // one chunk's base64 text
const BLOB_MAX = 16 * 1024 * 1024;
const MAX_CHUNKS = 64;
const MONEY_TABLES = ["pool_moves", "stash_moves", "fed_records", "fed_ops", "transactions", "jackpot_rakes", "reserve_claims", "capital_ops", "policy_mints"];
const READY = ["cfg"];                    // the features whose import exists (budget: PO-5, staking_ops: PO-8, loans_desk: PO-9)

const PC = () => require("./config");
const Refuse = (...a) => new (PC().Refuse)(...a);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const str = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));
const low = (s) => String(s || "").trim().replace(/^@+/, "").toLowerCase();

/** The actor must hold Pepe's owner role on the site (the pinned list, PO-0b). -> the login */
async function ownerActor(actor) {
  const a = low(actor).slice(0, 60);
  if (!a || (await require("../staffroles").roleOf(a)) !== "owner") throw Refuse(403, "owner_only", "Only a Pepe owner hands the economy over.");
  return a;
}
function featureOf(f) {
  const x = String(f || "");
  if (!PC().FEATURES.includes(x)) throw Refuse(400, "bad_feature", `no such feature (one of ${PC().FEATURES.join(", ")})`);
  if (!READY.includes(x)) throw Refuse(409, "not_ready", `${x} can't be handed over yet (its site service comes in a later slice)`);
  return x;
}
async function audit(actor, step, detail) {
  try { await require("../adminaudit").record({ userId: `chat:${actor}`.slice(0, 64), username: actor }, "policy.handover", null, Object.assign({ step }, detail)); }
  catch (e) { console.error("[handover] audit:", e.message); }
}
function alert(ref, title, body) {
  Promise.resolve().then(() => require("../opsalerts").alert({ source: "policy", ref, title, body })).catch((e) => console.error("[handover] alert:", e.message));
}

// ── freeze ──
async function freeze(b) {
  await PC().init();
  const feature = featureOf(b.feature);
  const actor = await ownerActor(b.actor);
  const on = b.on !== false;
  const r = await tx(async () => {
    const own = (await PC().ownership())[feature];
    if (on) {
      if (own.owner === "cutting") return { ok: true, dup: true, owner: "cutting" };
      if (own.owner === "site") throw Refuse(409, "site_owned", `${feature} is already the site's - nothing to freeze`);
      await PC().putOwner(feature, "cutting", { by: actor, note: str(b.note, 300) || "frozen for the hand-over" });
    } else {
      if (own.owner === "pepe") return { ok: true, dup: true, owner: "pepe" };
      if (own.owner === "site") throw Refuse(409, "site_owned", `${feature} is the site's - roll it back instead`);
      await PC().putOwner(feature, "pepe", { by: actor, note: str(b.note, 300) || "unfrozen" });
    }
    await C.audit({ by: actor, via: "handover", engine: "feature:" + feature, old: own.owner, new: on ? "cutting" : "pepe", note: b.note || (on ? "freeze" : "unfreeze") });
    return { ok: true, owner: on ? "cutting" : "pepe", was: own.owner };
  });
  if (!r.dup) await audit(actor, on ? "freeze" : "unfreeze", { feature });
  return r;
}

// ── the upload ──
async function row(key) {
  return (await getQuery("SELECT key, feature, state, size, chunks, imported_at, verify, by, created FROM policy_handovers WHERE key = ?", [key]))[0] || null;
}
const parseV = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
async function begin(b) {
  await PC().init();
  const feature = featureOf(b.feature);
  const actor = await ownerActor(b.actor);
  const key = String(b.key || "");
  const size = Math.trunc(Number(b.size)), chunks = Math.trunc(Number(b.chunks));
  if (!KEY_RE.test(key)) throw Refuse(400, "bad_key", "key = the export's sha256 (64 hex)");
  if (!(size > 0 && size <= BLOB_MAX)) throw Refuse(400, "bad_size", `size 1..${BLOB_MAX}`);
  if (!(chunks > 0 && chunks <= MAX_CHUNKS)) throw Refuse(400, "bad_chunks", `chunks 1..${MAX_CHUNKS}`);
  return tx(async () => {
    const own = (await PC().ownership())[feature];
    const r = await row(key);
    if (r && r.state === "imported") return { ok: true, dup: true, state: r.state, verify: parseV(r.verify) };
    if (own.owner !== "cutting") throw Refuse(409, "not_frozen", `${feature} isn't frozen - freeze it first (!econ policy freeze ${feature} confirm)`);
    if (r && r.feature === feature && r.state === "receiving" && Number(r.size) === size && Number(r.chunks) === chunks) {
      const have = (await getQuery("SELECT idx FROM policy_handover_chunks WHERE key = ? ORDER BY idx", [key])).map((x) => x.idx);
      return { ok: true, resumed: true, state: "receiving", have };
    }
    await runQuery("DELETE FROM policy_handover_chunks WHERE key = ?", [key]);
    await runQuery(`INSERT INTO policy_handovers (key, feature, state, size, chunks, by, created) VALUES (?, ?, 'receiving', ?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET feature = excluded.feature, state = 'receiving', size = excluded.size, chunks = excluded.chunks,
                      by = excluded.by, created = excluded.created, verify = NULL, blob = NULL`, [key, feature, size, chunks, actor, Date.now()]);
    return { ok: true, state: "receiving", have: [] };
  });
}
async function chunk(b) {
  await PC().init();
  const key = String(b.key || "");
  const idx = Number(b.idx);
  const data = typeof b.data === "string" ? b.data : "";
  if (!KEY_RE.test(key)) throw Refuse(400, "bad_key", "bad key");
  if (!data || data.length > CHUNK_MAX || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw Refuse(400, "bad_chunk", `a chunk is base64, at most ${CHUNK_MAX} characters`);
  return tx(async () => {
    const r = await row(key);
    if (!r) throw Refuse(404, "no_upload", "begin the upload first");
    if (r.state === "imported") return { ok: true, dup: true, state: r.state };
    if (r.state !== "receiving") throw Refuse(409, "not_receiving", `this upload is ${r.state} - begin again`);
    if (!Number.isInteger(idx) || idx < 0 || idx >= Number(r.chunks)) throw Refuse(400, "bad_idx", `idx 0..${Number(r.chunks) - 1}`);
    const have = (await getQuery("SELECT data FROM policy_handover_chunks WHERE key = ? AND idx = ?", [key, idx]))[0];
    if (have) {
      if (have.data !== data) throw Refuse(409, "chunk_differs", `chunk ${idx} was already sent with other bytes - begin again`);
      return { ok: true, dup: true, idx };
    }
    await runQuery("INSERT INTO policy_handover_chunks (key, idx, data) VALUES (?, ?, ?)", [key, idx, data]);
    const n = (await getQuery("SELECT COUNT(*) AS n FROM policy_handover_chunks WHERE key = ?", [key]))[0].n;
    return { ok: true, idx, received: Number(n), chunks: Number(r.chunks) };
  });
}

// ── the payload ──
/** A cfg export -> [errors] ([] = it may be imported). */
async function checkCfgPayload(p) {
  const errs = [];
  if (!p || typeof p !== "object" || p.v !== 1) return ["not a v1 export"];
  if (p.feature !== "cfg") return [`this is a ${p.feature || "?"} export, not cfg`];
  const cfg = p.cfg && typeof p.cfg === "object" && !Array.isArray(p.cfg) ? p.cfg : null;
  if (!cfg) return ["no cfg"];
  const missing = S.KEYS.filter((k) => !(k in cfg) || cfg[k] === null || cfg[k] === undefined);
  if (missing.length) errs.push(`missing ${missing.length} key(s): ${missing.join(", ")}`);
  const unknown = Object.keys(cfg).filter((k) => !S.SPEC[k]);
  if (unknown.length) errs.push(`unknown key(s) (put dead knobs in "archive"): ${unknown.join(", ")}`);
  for (const k of S.KEYS) if (k in cfg && cfg[k] !== null && !S.validValue(S.SPEC[k], cfg[k])) errs.push(S.keyError(k, S.SPEC[k], cfg[k]));
  if (!errs.length) errs.push(...S.validate(cfg, { catalog: await PC().routesCatalog() }));
  if (p.log !== undefined && (!Array.isArray(p.log) || p.log.length > 5000)) errs.push("log: a list of at most 5000 rows");
  if (p.ceil_log !== undefined && (!Array.isArray(p.ceil_log) || p.ceil_log.length > 5000)) errs.push("ceil_log: a list of at most 5000 rows");
  return errs;
}
async function moneyCounts() {
  const have = new Set((await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  const out = {};
  for (const t of MONEY_TABLES) if (have.has(t)) out[t] = Number((await getQuery(`SELECT COUNT(*) AS n FROM ${t}`))[0].n) || 0;
  return out;
}
async function supplyCheck() {
  try {
    const rows = await getQuery("SELECT day FROM supply_history ORDER BY day DESC LIMIT 8");
    const days = rows.map((r) => r.day).reverse();
    let gaps = 0;
    for (let i = 1; i < days.length; i++) if (Date.parse(days[i] + "T00:00:00Z") - Date.parse(days[i - 1] + "T00:00:00Z") !== 86400e3) gaps++;
    return { last_day: days[days.length - 1] || null, days: days.length, gap_free: gaps === 0 };
  } catch (e) { return { last_day: null, days: 0, gap_free: null }; }
}
const ms = (ts) => { const n = Number(ts); return Number.isFinite(n) && n > 0 ? Math.trunc(n < 1e12 ? n * 1000 : n) : null; };
/** In ONE transaction: the export's values -> policy_cfg (via "import"), Pepe's change log + ceiling log, the verify record. */
async function importCfg(p, key, actor) {
  return tx(async () => {
    const done = await row(key);
    if (done && done.state === "imported") return Object.assign({ dup: true }, parseV(done.verify));      // a concurrent commit won
    const own = (await PC().ownership()).cfg;
    if (own.owner !== "cutting") throw Refuse(409, "not_frozen", "cfg isn't frozen any more - freeze it again and re-run the import");
    const before = await moneyCounts();
    const snap = await PC().load();
    const diff = [];
    for (const k of S.KEYS) if (!(k in snap.cfg) || S.canon(snap.cfg[k]) !== S.canon(p.cfg[k])) diff.push([k, snap.cfg[k], p.cfg[k]]);
    let rev = snap.rev, sha = snap.sha;
    if (diff.length) ({ rev, sha } = await PC().writeChanges(diff, { by: actor, via: "import", note: `hand-over ${key.slice(0, 12)}`, snap }));
    let logN = 0;
    for (const e of (p.log || []).slice(-5000)) {
      const k = S.resolveKey(String((e || {}).key || "")) || String((e || {}).key || "").slice(0, 64);
      const t = ms(e && e.ts);
      if (!k || !t) continue;
      const nv = S.canon(e.new === undefined ? null : e.new);
      if ((await getQuery("SELECT 1 FROM policy_cfg_log WHERE via = 'import' AND ts = ? AND key = ? AND new = ? LIMIT 1", [t, k, nv])).length) continue;
      await runQuery("INSERT INTO policy_cfg_log (rev, ts, actor_user_id, actor, via, key, old, new, note) VALUES (?, ?, NULL, ?, 'import', ?, ?, ?, ?)",
                     [0, t, str(e.by, 60), k, S.canon(e.old === undefined ? null : e.old), nv, str(`on Pepe via ${e.via || "?"}`, 300)]);
      logN++;
    }
    let ceilN = 0;
    for (const e of (p.ceil_log || []).slice(-5000)) {
      const t = ms(e && e.ts);
      if (!t || (await getQuery("SELECT 1 FROM capital_ceil_log WHERE ts = ? AND via = 'import' LIMIT 1", [t])).length) continue;
      await runQuery("INSERT INTO capital_ceil_log (ts, rev, ceil_apr, ceil_cushion, ceil_cushion_days, by, via) VALUES (?, 0, ?, ?, ?, 'pepe', 'import')",
                     [t, Number.isFinite(Number(e.ceil_apr)) ? Number(e.ceil_apr) : null, Number.isFinite(Number(e.ceil_cushion)) ? Math.trunc(Number(e.ceil_cushion)) : null,
                      Number.isFinite(Number(e.ceil_cushion_days)) ? Number(e.ceil_cushion_days) : null]);
      ceilN++;
    }
    const after = await moneyCounts();
    const moved = Object.keys(Object.assign({}, before, after)).filter((t) => before[t] !== after[t]);
    if (moved.length) throw Refuse(500, "money_rows", `the import would have written money rows (${moved.join(", ")}) - rolled back`);
    const now = await PC().load();
    const blobCfg = {};
    for (const k of S.KEYS) blobCfg[k] = p.cfg[k];
    const siteCfg = {};
    for (const k of S.KEYS) siteCfg[k] = now.cfg[k];
    const mismatched = S.KEYS.filter((k) => S.canon(blobCfg[k]) !== S.canon(siteCfg[k]));
    const verify = { ok: !mismatched.length, key, feature: "cfg", keys: S.KEYS.length, digest: sha256(S.canon(blobCfg)), site_digest: sha256(S.canon(siteCfg)),
                     mismatched, changed: diff.length, rev, sha, log_imported: logN, ceil_log_imported: ceilN,
                     money_rows: Object.fromEntries(Object.keys(after).map((t) => [t, after[t] - (before[t] || 0)])), supply: await supplyCheck(),
                     archived: Object.keys(p.archive && typeof p.archive === "object" ? p.archive : {}), at: Date.now(), by: actor };
    await runQuery("UPDATE policy_handovers SET state = 'imported', imported_at = ?, verify = ?, blob = ?, by = ? WHERE key = ?",
                   [Date.now(), JSON.stringify(verify), JSON.stringify(p), actor, key]);
    await runQuery("DELETE FROM policy_handover_chunks WHERE key = ?", [key]);
    return verify;
  });
}
async function commit(b) {
  await PC().init();
  const actor = await ownerActor(b.actor);
  const key = String(b.key || "");
  if (!KEY_RE.test(key)) throw Refuse(400, "bad_key", "bad key");
  const r = await row(key);
  if (!r) throw Refuse(404, "no_upload", "begin the upload first");
  if (r.state === "imported") return { ok: true, dup: true, verify: parseV(r.verify) };
  if (r.state !== "receiving") throw Refuse(409, "not_receiving", `this upload is ${r.state} - begin again`);
  const parts = await getQuery("SELECT idx, data FROM policy_handover_chunks WHERE key = ? ORDER BY idx", [key]);
  if (parts.length !== Number(r.chunks) || parts.some((x, i) => x.idx !== i)) {
    const have = new Set(parts.map((x) => x.idx));
    throw Refuse(409, "incomplete", `chunks missing: ${[...Array(Number(r.chunks)).keys()].filter((i) => !have.has(i)).join(", ")}`);
  }
  const buf = Buffer.concat(parts.map((x) => Buffer.from(x.data, "base64")));
  const drop = async (state, why) => {
    await tx(async () => {
      await runQuery("UPDATE policy_handovers SET state = ?, verify = ? WHERE key = ?", [state, JSON.stringify({ ok: false, error: why }), key]);
      await runQuery("DELETE FROM policy_handover_chunks WHERE key = ?", [key]);
    });
  };
  if (buf.length !== Number(r.size) || sha256(buf) !== key) {
    await drop("bad_sha", "the bytes' sha256 / size don't match the key");
    throw Refuse(409, "sha_mismatch", `the upload's sha256 is ${sha256(buf)} (${buf.length} bytes), not the key - nothing imported; export and send it again`);
  }
  const p = parseV(buf.toString("utf8"));
  const errs = r.feature === "cfg" ? await checkCfgPayload(p) : ["unknown feature"];
  if (errs.length) {
    await drop("refused", errs.join("; ").slice(0, 2000));
    throw Refuse(400, "bad_payload", "nothing imported: " + errs.join("; "), { errors: errs });
  }
  const verify = await importCfg(p, key, actor);
  if (verify.dup) { delete verify.dup; return { ok: true, dup: true, verify }; }      // a concurrent commit imported it
  PC().forget();
  await audit(actor, "import", { feature: r.feature, key, changed: verify.changed, log: verify.log_imported });
  return { ok: true, verify };
}
async function verifyRec(b) {
  await PC().init();
  const key = String(b.key || "");
  if (!KEY_RE.test(key)) throw Refuse(400, "bad_key", "bad key");
  const r = (await getQuery("SELECT key, feature, state, verify, blob, imported_at FROM policy_handovers WHERE key = ?", [key]))[0];
  if (!r) throw Refuse(404, "no_upload", "no such hand-over");
  const v = parseV(r.verify);
  if (r.state !== "imported") return { ok: false, state: r.state, verify: v };
  const p = parseV(r.blob) || {};
  const snap = await PC().load();
  const mismatched = S.KEYS.filter((k) => S.canon((p.cfg || {})[k]) !== S.canon(snap.cfg[k]));
  const siteCfg = {};
  for (const k of S.KEYS) siteCfg[k] = snap.cfg[k];
  return { ok: true, state: r.state, verify: v, now: { equal: !mismatched.length, mismatched, site_digest: sha256(S.canon(siteCfg)), rev: snap.rev, sha: snap.sha,
                                                       owner: snap.own[r.feature].owner } };
}

// ── the flip and the way back ──
async function cutover(b) {
  await PC().init();
  const feature = featureOf(b.feature);
  const actor = await ownerActor(b.actor);
  const key = String(b.key || "");
  if (!KEY_RE.test(key)) throw Refuse(400, "bad_key", "name the imported hand-over (its key)");
  const out = await tx(async () => {
    const own = (await PC().ownership())[feature];
    if (own.owner === "site" && own.handover_key === key) return { ok: true, dup: true, owner: "site" };
    if (own.owner !== "cutting") throw Refuse(409, "not_frozen", `${feature} is ${own.owner} - freeze, export and import first`);
    const r = (await getQuery("SELECT feature, state, blob FROM policy_handovers WHERE key = ?", [key]))[0];
    if (!r || r.feature !== feature || r.state !== "imported") throw Refuse(409, "not_imported", "that hand-over isn't imported");
    const p = parseV(r.blob) || {};
    const snap = await PC().load();
    const mismatched = S.KEYS.filter((k) => S.canon((p.cfg || {})[k]) !== S.canon(snap.cfg[k]));
    if (mismatched.length) throw Refuse(409, "changed_since", `the site's values differ from the import on ${mismatched.join(", ")} - import again`);
    await PC().putOwner(feature, "site", { by: actor, handoverKey: key, note: str(b.note, 300) || "cutover" });
    await C.audit({ by: actor, via: "handover", engine: "feature:" + feature, old: "cutting", new: "site", note: `cutover ${key.slice(0, 12)}` });
    return { ok: true, owner: "site", rev: snap.rev, sha: snap.sha };
  });
  if (!out.dup) {
    await PC().refresh().catch(() => {});
    try { require("../funding").reapplyPolicy(); } catch (e) { /* funding not loaded */ }
    await audit(actor, "cutover", { feature, key });
    alert(`handover-${feature}:${key.slice(0, 16)}`, `Economy ${feature} handed over to the site by ${actor}`,
          "The site's policy config store is the writer now: /admin/economy#policy edits it (owners, password step-up); Pepe reads it.");
  }
  return out;
}
async function rollback(b) {
  await PC().init();
  const feature = featureOf(b.feature);
  const actor = await ownerActor(b.actor);
  const out = await tx(async () => {
    const own = await PC().ownership();
    if (own[feature].owner !== "site") throw Refuse(409, "not_site", `${feature} isn't the site's (${own[feature].owner})`);
    // reverse order (plan 2.3): the budget, then the engines, then the config
    if (own.budget.owner === "site") throw Refuse(409, "order", "roll the budget back first (H2b before H1)");
    const live = (await C.engines());
    const liveE = Object.values(live).filter((e) => e.mode === "live").map((e) => e.engine);
    if (liveE.length) throw Refuse(409, "order", `roll the engines back first (${liveE.join(", ")} live on the site: !econ engines rollback)`);
    const snap = await PC().load();
    const since = Number(own[feature].since) || 0;
    const log = await getQuery("SELECT rev, ts, actor, via, key, old, new, note FROM policy_cfg_log WHERE ts >= ? AND via IN ('web','chat','migration','cli') ORDER BY id", [since]);
    await PC().putOwner(feature, "pepe", { by: actor, note: str(b.note, 300) || "rollback" });
    await C.audit({ by: actor, via: "handover", engine: "feature:" + feature, old: "site", new: "pepe", note: "rollback" });
    return { ok: true, owner: "pepe", rev: snap.rev, sha: snap.sha, cfg: snap.cfg, log };
  });
  await PC().refresh().catch(() => {});
  await audit(actor, "rollback", { feature, rev: out.rev });
  alert(`rollback-${feature}:${out.rev}:${Date.now()}`, `Economy ${feature} rolled back to Pepe by ${actor}`, `Pepe writes the site's values (rev ${out.rev}) and is the writer again; the site mirrors him.`);
  return out;
}

function register(app, { isBotToken }) {
  const bot = (fn) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (e && e.status && e.code) return res.status(e.status).json(Object.assign({ ok: false, code: e.code, error: e.message }, e.extra || {}));
      console.error("[handover]", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  app.post("/api/policy/bot/handover/freeze", bot(freeze));
  app.post("/api/policy/bot/handover/begin", bot(begin));
  app.post("/api/policy/bot/handover/chunk", require("express").json({ limit: "1mb" }), bot(chunk));
  app.post("/api/policy/bot/handover/commit", bot(commit));
  app.post("/api/policy/bot/handover/verify", bot(verifyRec));
  app.post("/api/policy/bot/handover/cutover", bot(cutover));
  app.post("/api/policy/bot/handover/rollback", bot(rollback));
}

module.exports = { register, freeze, begin, chunk, commit, verify: verifyRec, cutover, rollback, checkCfgPayload, moneyCounts, MONEY_TABLES, CHUNK_MAX, KEY_RE };
