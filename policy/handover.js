// policy/handover.js — PO-2 of the economy policy -> site plan ("Phase 6", plan sections 5 and 6.2): the site's half of a policy
// feature's HAND-OVER from Pepe (H1 = the config: policy_ownership.cfg pepe -> site). Pepe drives it (PO-3: `!econ policy
// freeze|export|cutover|rollback cfg confirm`, a Pepe owner by role); every step is a bot-token call that names the actor, and the
// site checks that actor holds Pepe's owner role HERE (the pinned owner list, PO-0b) - never Telegram (via "telegram" is 403; the
// steps are chat commands, any other via is 400).
//
//   POST /api/policy/bot/handover/freeze   {feature, actor, on}     pepe -> cutting (frozen: the mirror stops, every edit is 423)
//                                                                   / back (on: false). The freeze keeps the store's values as they
//                                                                   stood (cfg_freeze): what the readers used at that moment
//   POST /api/policy/bot/handover/begin    {feature, key, size, chunks, actor}   key = sha256 of the export (hex); needs "cutting"
//   POST /api/policy/bot/handover/chunk    {key, idx, data}         data = base64 of bytes [idx x chunk size ..); its own body limit
//                                                                   (index.js skips it: the 100 KB parser trap behind the 1,913
//                                                                   PayloadTooLarge errors); the same chunk again is a no-op
//   POST /api/policy/bot/handover/commit   {key, actor}             the chunks joined, sha256 checked (a mismatch is refused and
//                                                                   the chunks dropped), the payload checked (every SPEC key, each
//                                                                   valid, the whole config valid), then ONE dbUtils.tx: policy_cfg
//                                                                   (via "import"), Pepe's change log (original ts / who), his
//                                                                   ceiling log -> capital_ceil_log, the verify record, the audit
//                                                                   row. The money tables' rows are counted and their balances
//                                                                   summed before and after INSIDE it: an import that would write a
//                                                                   money row or move a balance rolls back. A rerun answers dup.
//   POST /api/policy/bot/handover/verify   {key}                    the verify record + a live recheck (per-key equality, digests,
//                                                                   the readers)
//   POST /api/policy/bot/handover/cutover  {feature, key, actor, force?}   cutting -> site, only with that key imported, the store
//                                                                   still equal to it AND (review of PO-2) the import equal to what
//                                                                   every reader uses today: the values at the freeze and Pepe's
//                                                                   pushes as the consumers read them (policy/config.pushCheck). A
//                                                                   difference is refused (409 differs, the keys listed) unless
//                                                                   `force` names exactly those keys - the owner's explicit go
//   POST /api/policy/bot/handover/rollback {feature, actor}         step 1 (review of PO-2: the site no longer flips back before Pepe
//                                                                   has the values): refused while an engine is live or the budget is
//                                                                   the site's (reverse order); the site KEEPS the config - its
//                                                                   readers keep its values, every edit is 423 - and answers its
//                                                                   values, rev, sha and its change log since the flip, for Pepe to
//                                                                   write back
//                                          {feature, actor, confirm_sha, force?}   step 2, once Pepe wrote them back and pushed: the
//                                                                   sha handed back, still the store's; his policy and capital pushes
//                                                                   seen since step 1 and every reader's push value equal to the
//                                                                   store (else 409 push_behind - unless `force` names exactly the
//                                                                   keys that differ). Then site -> pepe, econstore's routing table
//                                                                   = the routes handed back, the funding block re-applied
//                                          {feature, actor, cancel: true}   ends a step 1 without handing back (the site keeps it)
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
// review of PO-2: a balance UPDATE writes no row - the balances are summed too (a table / column a site doesn't have is skipped)
const MONEY_SUMS = [["users", "points_balance"], ["pools", "balance"], ["stashes", "balance"], ["stashes", "staked"], ["stashes", "earned"], ["escrow_holds", "amount"]];
const READY = ["cfg"];                    // the features whose import exists (budget: PO-5, staking_ops: PO-8, loans_desk: PO-9)
const DIFFS_KEPT = 100;                   // reader differences kept in a verify record / an answer

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
/** Review of PO-2: the hand-over steps are Pepe's chat commands - never Telegram (403); anything else isn't one of them (400). */
function chatOnly(b) {
  const v = b.via === undefined || b.via === null || b.via === "" ? "chat" : String(b.via);
  if (v === "telegram") throw Refuse(403, "telegram", "The economy is never handed over (or back) from Telegram.");
  if (v !== "chat") throw Refuse(400, "bad_via", "The hand-over steps are Pepe's chat commands (via chat).");
}
function featureOf(f) {
  const x = String(f || "");
  if (!PC().FEATURES.includes(x)) throw Refuse(400, "bad_feature", `no such feature (one of ${PC().FEATURES.join(", ")})`);
  if (!READY.includes(x)) throw Refuse(409, "not_ready", `${x} can't be handed over yet (its site service comes in a later slice)`);
  return x;
}
/** The admin_audit row of a step - IN the step's transaction (review of PO-2: a step and its audit row land together or not at all). */
async function audit(actor, step, detail) {
  await require("../adminaudit").record({ userId: `chat:${actor}`.slice(0, 64), username: actor }, "policy.handover", null, Object.assign({ step }, detail));
}
function alert(ref, title, body) {
  Promise.resolve().then(() => require("../opsalerts").alert({ source: "policy", ref, title, body })).catch((e) => console.error("[handover] alert:", e.message));
}
/** `force` -> the site keys it names (aliases resolved), sorted, deduped. */
function forceKeys(b) {
  if (!Array.isArray(b.force)) return [];
  return [...new Set(b.force.map((k) => S.resolveKey(String(k)) || String(k).slice(0, 64)))].sort();
}
/** The owner's explicit go on a difference: `force` must name EXACTLY the keys that differ (nothing more, nothing less). */
function checkForce(force, differs, code, what, extra) {
  if (!differs.length) {
    if (force.length) throw Refuse(409, "force_mismatch", `nothing differs - ${what} without force`, { differs });
    return;
  }
  if (!force.length) throw Refuse(409, code, extra.message, Object.assign({ differs }, extra.data));
  if (force.join(",") !== differs.join(",")) {
    throw Refuse(409, "force_mismatch", `force must name exactly the keys that differ: ${differs.join(", ")} (it named ${force.join(", ")})`, { differs });
  }
}
const trimDiffs = (diffs) => diffs.slice(0, DIFFS_KEPT).map((d) => ({ consumer: d.consumer, field: d.field, keys: d.keys,
                                                                        push: S.canon(d.push).slice(0, 300), site: S.canon(d.site).slice(0, 300) }));

// ── freeze ──
async function freeze(b) {
  await PC().init();
  const feature = featureOf(b.feature);
  const actor = await ownerActor(b.actor);
  chatOnly(b);
  const on = b.on !== false;
  const r = await tx(async () => {
    const own = (await PC().ownership())[feature];
    if (on) {
      if (own.owner === "cutting") return { ok: true, dup: true, owner: "cutting" };
      if (own.owner === "site") throw Refuse(409, "site_owned", `${feature} is already the site's - nothing to freeze`);
      await PC().putOwner(feature, "cutting", { by: actor, note: str(b.note, 300) || "frozen for the hand-over" });
      // the values every reader used at the freeze (the mirror of Pepe's pushes): an import is compared with THESE, however many
      // imports follow
      const snap = await PC().load();
      await C.setMeta("cfg_freeze", { since: snap.own[feature].since, rev: snap.rev, sha: snap.sha, cfg: snap.cfg, by: actor, at: Date.now() });
    } else {
      if (own.owner === "pepe") return { ok: true, dup: true, owner: "pepe" };
      if (own.owner === "site") throw Refuse(409, "site_owned", `${feature} is the site's - roll it back instead`);
      await PC().putOwner(feature, "pepe", { by: actor, note: str(b.note, 300) || "unfrozen" });
    }
    await C.audit({ by: actor, via: "handover", engine: "feature:" + feature, old: own.owner, new: on ? "cutting" : "pepe", note: b.note || (on ? "freeze" : "unfreeze") });
    await audit(actor, on ? "freeze" : "unfreeze", { feature });
    return { ok: true, owner: on ? "cutting" : "pepe", was: own.owner };
  });
  await PC().refresh().catch(() => {});
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
  chatOnly(b);
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
async function tableNames() { return new Set((await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name)); }
async function moneyCounts() {
  const have = await tableNames();
  const out = {};
  for (const t of MONEY_TABLES) if (have.has(t)) out[t] = Number((await getQuery(`SELECT COUNT(*) AS n FROM ${t}`))[0].n) || 0;
  return out;
}
/** Review of PO-2: the balances (users' wallets, the pools, the stashes, the escrow holds) summed - an UPDATE writes no row. */
async function moneySums() {
  const have = await tableNames();
  const out = {};
  for (const [t, c] of MONEY_SUMS) {
    if (!have.has(t)) continue;
    const cols = new Set((await getQuery(`PRAGMA table_info(${t})`)).map((x) => x.name));
    if (!cols.has(c)) continue;
    out[`${t}.${c}`] = Number((await getQuery(`SELECT COALESCE(SUM(${c}), 0) AS s FROM ${t}`))[0].s) || 0;
  }
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
/** The export's keys whose value differs from `base` (the values at the freeze). */
const differingKeys = (base, cfg) => S.KEYS.filter((k) => !(base && k in base) || S.canon(base[k]) !== S.canon(cfg[k]));
/** In ONE transaction: the export's values -> policy_cfg (via "import"), Pepe's change log + ceiling log, the verify record, the
 *  audit row. verify.ok (review of PO-2) = the store equals the export AND the export equals what the readers used: the values
 *  at the freeze (changed_keys) and Pepe's pushes as each consumer reads them now (readers). */
async function importCfg(p, key, actor) {
  return tx(async () => {
    const done = await row(key);
    if (done && done.state === "imported") return Object.assign({ dup: true }, parseV(done.verify));      // a concurrent commit won
    const own = (await PC().ownership()).cfg;
    if (own.owner !== "cutting") throw Refuse(409, "not_frozen", "cfg isn't frozen any more - freeze it again and re-run the import");
    const before = await moneyCounts(), sumsBefore = await moneySums();
    const snap = await PC().load();
    const fz = await C.meta("cfg_freeze");
    const base = fz && fz.cfg && Number(fz.since) === Number(own.since) ? fz.cfg : snap.cfg;
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
    const after = await moneyCounts(), sumsAfter = await moneySums();
    const moved = Object.keys(Object.assign({}, before, after)).filter((t) => before[t] !== after[t]);
    if (moved.length) throw Refuse(500, "money_rows", `the import would have written money rows (${moved.join(", ")}) - rolled back`);
    const shifted = Object.keys(Object.assign({}, sumsBefore, sumsAfter)).filter((t) => sumsBefore[t] !== sumsAfter[t]);
    if (shifted.length) throw Refuse(500, "money_rows", `the import would have moved balances (${shifted.join(", ")}) - rolled back`);
    const now = await PC().load();
    const blobCfg = {};
    for (const k of S.KEYS) blobCfg[k] = p.cfg[k];
    const siteCfg = {};
    for (const k of S.KEYS) siteCfg[k] = now.cfg[k];
    const mismatched = S.KEYS.filter((k) => S.canon(blobCfg[k]) !== S.canon(siteCfg[k]));
    const changedKeys = differingKeys(base, blobCfg);
    const readers = await PC().pushCheck(blobCfg);
    const differs = [...new Set([...changedKeys, ...readers.keys])].sort();
    const verify = { ok: !mismatched.length && !differs.length, key, feature: "cfg", keys: S.KEYS.length, digest: sha256(S.canon(blobCfg)), site_digest: sha256(S.canon(siteCfg)),
                     mismatched, changed: diff.length, changed_keys: changedKeys, base: base === snap.cfg ? "store" : "freeze", readers: trimDiffs(readers.diffs),
                     differs, rev, sha, log_imported: logN, ceil_log_imported: ceilN,
                     money_rows: Object.fromEntries(Object.keys(after).map((t) => [t, after[t] - (before[t] || 0)])),
                     money_sums: Object.fromEntries(Object.keys(sumsAfter).map((t) => [t, sumsAfter[t] - (sumsBefore[t] || 0)])), supply: await supplyCheck(),
                     archived: Object.keys(p.archive && typeof p.archive === "object" ? p.archive : {}), at: Date.now(), by: actor };
    await runQuery("UPDATE policy_handovers SET state = 'imported', imported_at = ?, verify = ?, blob = ?, by = ? WHERE key = ?",
                   [Date.now(), JSON.stringify(verify), JSON.stringify(p), actor, key]);
    await runQuery("DELETE FROM policy_handover_chunks WHERE key = ?", [key]);
    await audit(actor, "import", { feature: "cfg", key, changed: diff.length, differs, log: logN });
    return verify;
  });
}
async function commit(b) {
  await PC().init();
  const actor = await ownerActor(b.actor);
  chatOnly(b);
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
  return { ok: true, verify };
}
async function verifyRec(b) {
  await PC().init();
  const key = String(b.key || "");
  if (!KEY_RE.test(key)) throw Refuse(400, "bad_key", "bad key");
  return tx(async () => {
    const r = (await getQuery("SELECT key, feature, state, verify, blob, imported_at FROM policy_handovers WHERE key = ?", [key]))[0];
    if (!r) throw Refuse(404, "no_upload", "no such hand-over");
    const v = parseV(r.verify);
    if (r.state !== "imported") return { ok: false, state: r.state, verify: v };
    const p = parseV(r.blob) || {};
    const snap = await PC().load();
    const mismatched = S.KEYS.filter((k) => S.canon((p.cfg || {})[k]) !== S.canon(snap.cfg[k]));
    const siteCfg = {};
    for (const k of S.KEYS) siteCfg[k] = snap.cfg[k];
    const readers = await PC().pushCheck(p.cfg || {});
    const differs = [...new Set([...((v && v.changed_keys) || []), ...readers.keys])].sort();
    return { ok: true, state: r.state, verify: v, now: { equal: !mismatched.length, mismatched, site_digest: sha256(S.canon(siteCfg)), rev: snap.rev, sha: snap.sha,
                                                         owner: snap.own[r.feature].owner, readers: trimDiffs(readers.diffs), differs, ready: !mismatched.length && !differs.length } };
  });
}

// ── the flip and the way back ──
async function cutover(b) {
  await PC().init();
  const feature = featureOf(b.feature);
  const actor = await ownerActor(b.actor);
  chatOnly(b);
  const key = String(b.key || "");
  if (!KEY_RE.test(key)) throw Refuse(400, "bad_key", "name the imported hand-over (its key)");
  const force = forceKeys(b);
  const out = await tx(async () => {
    const own = (await PC().ownership())[feature];
    if (own.owner === "site" && own.handover_key === key) return { ok: true, dup: true, owner: "site" };
    if (own.owner !== "cutting") throw Refuse(409, "not_frozen", `${feature} is ${own.owner} - freeze, export and import first`);
    const r = (await getQuery("SELECT feature, state, blob, verify FROM policy_handovers WHERE key = ?", [key]))[0];
    if (!r || r.feature !== feature || r.state !== "imported") throw Refuse(409, "not_imported", "that hand-over isn't imported");
    const p = parseV(r.blob) || {};
    const v = parseV(r.verify) || {};
    const snap = await PC().load();
    const mismatched = S.KEYS.filter((k) => S.canon((p.cfg || {})[k]) !== S.canon(snap.cfg[k]));
    if (mismatched.length) throw Refuse(409, "changed_since", `the site's values differ from the import on ${mismatched.join(", ")} - import again`);
    // review of PO-2: the readers switch to these values at the flip - re-checked NOW against what each of them uses today
    const readers = await PC().pushCheck(p.cfg || {});
    const differs = [...new Set([...(v.changed_keys || []), ...readers.keys])].sort();
    checkForce(force, differs, "differs", "cut over", {
      message: `the import differs from what the readers use today on ${differs.join(", ")} - the readers would switch to other values at the flip. Push again and re-import, or cut over naming exactly those keys (force)`,
      data: { readers: trimDiffs(readers.diffs), changed_keys: v.changed_keys || [] } });
    await PC().putOwner(feature, "site", { by: actor, handoverKey: key, note: str(b.note, 300) || (force.length ? `cutover FORCED on ${force.join(", ")}` : "cutover") });
    await C.audit({ by: actor, via: "handover", engine: "feature:" + feature, old: "cutting", new: "site", note: `cutover ${key.slice(0, 12)}${force.length ? " FORCED on " + force.join(",") : ""}` });
    await audit(actor, "cutover", { feature, key, forced: force });
    return { ok: true, owner: "site", rev: snap.rev, sha: snap.sha, forced: force };
  });
  if (!out.dup) {
    await PC().refresh().catch(() => {});
    try { require("../funding").reapplyPolicy(); } catch (e) { /* funding not loaded */ }
    alert(`handover-${feature}:${key.slice(0, 16)}`, `Economy ${feature} handed over to the site by ${actor}${out.forced.length ? ` (FORCED on ${out.forced.join(", ")})` : ""}`,
          "The site's policy config store is the writer now: /admin/economy#policy edits it (owners, password step-up); Pepe reads it.");
  }
  return out;
}
/** The config goes back last (plan 2.3): refused while the budget is the site's or an engine is live on it. In the caller's tx. */
async function reverseOrder(own) {
  own = own || await PC().ownership();
  if (own.budget.owner === "site") throw Refuse(409, "order", "roll the budget back first (H2b before H1)");
  const liveE = Object.values(await C.engines()).filter((e) => e.mode === "live").map((e) => e.engine);
  if (liveE.length) throw Refuse(409, "order", `roll the engines back first (${liveE.join(", ")} live on the site: !econ engines rollback)`);
}
/** Rollback step 1: the site keeps the config (its readers keep its values, edits are 423) and hands its values back. */
async function rollback(b) {
  await PC().init();
  const feature = featureOf(b.feature);
  const actor = await ownerActor(b.actor);
  chatOnly(b);
  if (b.cancel === true) return cancelReturn(feature, actor, b);
  if (b.confirm_sha !== undefined && b.confirm_sha !== null && b.confirm_sha !== "") return confirmReturn(feature, actor, String(b.confirm_sha), b);
  const out = await tx(async () => {
    const own = await PC().ownership();
    const f = own[feature];
    if (f.owner !== "site") throw Refuse(409, "not_site", `${feature} isn't the site's (${f.owner})`);
    await reverseOrder(own);
    const snap = await PC().load();
    const since = Number(f.since) || 0;
    const log = await getQuery("SELECT rev, ts, actor, via, key, old, new, note FROM policy_cfg_log WHERE ts >= ? AND via IN ('web','chat','migration','cli') ORDER BY id", [since]);
    const answer = { ok: true, phase: "returning", owner: "site", rev: snap.rev, sha: snap.sha, cfg: snap.cfg, log,
                     next: `write these values back, push, then: rollback ${feature} with confirm_sha = ${snap.sha}` };
    if (f.return_sha) {
      if (f.return_sha !== snap.sha) throw Refuse(409, "changed_since", "the site's values changed since they were handed back - cancel and roll back again");
      return Object.assign({ dup: true }, answer);
    }
    await PC().putReturning(feature, snap.sha, { by: actor, note: str(b.note, 300) || "rollback: handing the values back" });
    await C.audit({ by: actor, via: "handover", engine: "feature:" + feature, old: "site", new: "returning", note: `rollback - handing back ${snap.sha.slice(0, 12)}` });
    await audit(actor, "rollback", { feature, rev: snap.rev, sha: snap.sha });
    return answer;
  });
  if (!out.dup) {
    await PC().refresh().catch(() => {});
    alert(`rollback-${feature}:${out.rev}:${Date.now()}`, `Economy ${feature} being handed back to Pepe by ${actor}`,
          `The site keeps the settings (rev ${out.rev}) and refuses edits until Pepe has written them back and confirms; then he is the writer again.`);
  }
  return out;
}
/** Rollback step 2: Pepe wrote the values back and pushed - his pushes carry them; then site -> pepe. */
async function confirmReturn(feature, actor, confirmSha, b) {
  const force = forceKeys(b);
  const out = await tx(async () => {
    const f = (await PC().ownership())[feature];
    const done = await C.meta(`returned:${feature}`);
    if (f.owner !== "site" && done && done.sha === confirmSha) return Object.assign({ ok: true, dup: true, owner: f.owner }, done);
    if (f.owner !== "site" || !f.return_sha) throw Refuse(409, "not_returning", `${feature} isn't being handed back - roll back first (it hands the values back)`);
    if (f.return_sha !== confirmSha) throw Refuse(409, "sha_differs", `that isn't the sha handed back (${f.return_sha.slice(0, 12)}...)`);
    // the reverse order still holds at the flip (an engine or the budget may have gone to the site since step 1)
    await reverseOrder();
    const snap = await PC().load();
    if (snap.sha !== confirmSha) throw Refuse(409, "changed_since", "the site's values changed since they were handed back - cancel and roll back again");
    // his pushes since step 1 must carry the values handed back (the readers switch to them now)
    const readers = await PC().pushCheck(snap.cfg, { routes: false });
    // the policy push always; the capital push when he pushes one at all (a site that never got one has no capital reader of it)
    const t0 = Number(f.return_at) || 0;
    const behind = ["policy", "capital"].filter((k) => (k === "policy" || Number(readers.seen[k] || 0) > 0) && !(Number(readers.seen[k] || 0) >= t0));
    if (behind.length) throw Refuse(409, "push_behind", `Pepe hasn't pushed his ${behind.join(" and ")} config since the values were handed back - push, then confirm`, { behind });
    checkForce(force, readers.keys, "push_behind", "confirm", {
      message: `Pepe's pushes don't carry the values handed back yet (${readers.keys.join(", ")}) - write them back and push, then confirm (or name exactly those keys: force)`,
      data: { readers: trimDiffs(readers.diffs) } });
    await PC().putOwner(feature, "pepe", { by: actor, note: str(b.note, 300) || (force.length ? `rollback FORCED on ${force.join(", ")}` : "rollback confirmed") });
    // econstore's routing table (what the routing readers use while Pepe owns the config) = the routes handed back: his pushed
    // table was ignored while the site owned them
    await require("../econstore").putSettings({ pat_routes: snap.cfg.pat_routes || {}, actor: `rollback ${actor}`, via: "rollback" });
    const rec = { sha: confirmSha, rev: snap.rev, at: Date.now(), by: actor, forced: force };
    await C.setMeta(`returned:${feature}`, rec);
    await C.audit({ by: actor, via: "handover", engine: "feature:" + feature, old: "site", new: "pepe", note: `rollback confirmed ${confirmSha.slice(0, 12)}${force.length ? " FORCED on " + force.join(",") : ""}` });
    await audit(actor, "rollback_confirm", { feature, rev: snap.rev, sha: confirmSha, forced: force });
    return { ok: true, owner: "pepe", rev: snap.rev, sha: snap.sha, forced: force };
  });
  if (!out.dup) {
    await PC().refresh().catch(() => {});
    try { require("../funding").reapplyPolicy(); } catch (e) { /* funding not loaded */ }
    alert(`rollback-${feature}:${out.rev}:${Date.now()}`, `Economy ${feature} rolled back to Pepe by ${actor}${out.forced.length ? ` (FORCED on ${out.forced.join(", ")})` : ""}`,
          `Pepe has the site's values (rev ${out.rev}) and is the writer again; the site mirrors him.`);
  }
  return out;
}
/** Ends a rollback's step 1 without handing back: the site keeps the config and takes edits again. */
async function cancelReturn(feature, actor, b) {
  return tx(async () => {
    const f = (await PC().ownership())[feature];
    if (!f.return_sha) return { ok: true, dup: true, owner: f.owner };
    await PC().putReturning(feature, null, { by: actor, note: str(b.note, 300) || "rollback cancelled" });
    await C.audit({ by: actor, via: "handover", engine: "feature:" + feature, old: "returning", new: "site", note: "rollback cancelled" });
    await audit(actor, "rollback_cancel", { feature });
    return { ok: true, owner: "site", cancelled: true };
  });
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

module.exports = { register, freeze, begin, chunk, commit, verify: verifyRec, cutover, rollback, checkCfgPayload, moneyCounts, moneySums, MONEY_TABLES, MONEY_SUMS,
                   CHUNK_MAX, KEY_RE };
