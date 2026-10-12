// voicestore.js — 🗣️ the VOICE STORE (1.99rh; soundboards design S2 idea 2 + S3 owner controls).
//
// Pepe's TTS voices (VoiceBox profiles) used to be priced only in his bot settings (`voice_shop` {voice: price, unlock,
// owner, royalty} + `voice_unlocks`). The catalogue now lives HERE and Pepe is a client of it while his voice-store backend
// switch is on (voicestore_client.json; local only when switched OFF explicitly - the user's dual-path rule):
//   * Pepe imports what he has once (POST /api/voices/bot/import: every VoiceBox voice name, his voice_shop and
//     voice_unlocks) - idempotent, never overwriting what was edited here; existing owned voices are KEPT as they are
//     (D10: consent is on file outside the system - staff can tick "consent on file (manual)" on /admin/soundboards#voices)
//   * every sync (POST /api/voices/bot/sync) hands him the catalogue + who owns which unlock; he charges per-use prices
//     himself (the voice route, the owner's cut = a likeness subject leg, likeness.js)
//   * unlocks are bought HERE (/voices, or `!buyvoice` -> POST /api/voices/bot/buy): one boosts.tx - debit, premium
//     routing row voice_unlock, the owner's 20% likeness cut (siteCut), the voice_owned row
//   * owners manage their voice on /voices/mine: listed, others' free text (D12: off by default for NEW clones), soundboard
//     use, prices within the bands (per use 0-10,000; unlock 0 or 100,000-1,000,000), their royalty (10-50%), pause.
//     Revoking (S3, voiceclone.js) stops every use at once.
// Previews: one sample line per voice, rendered once by Pepe through the soundboard render queue (sb_clips board "sample").
//
//   voices         id (lower-case VoiceBox name), display, kind stock|clone|preset, owner_user_id, owner_login, price_use, price_unlock,
//                  royalty_pct, listed, allow_free_text, allow_soundboard, status active|paused|revoked|pending, consent_id,
//                  consent_manual, engine, vb_profile, sample_clip, created, updated
//   voice_owned    user_id, voice_id, source buy|gift|comp|import|owner, price, ref, created
//   voice_owned_logins   login, voice_id, source, created   (imported unlocks whose Camfrog login has no PATV account yet)
"use strict";
const crypto = require("crypto");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");

const BANDS = Object.freeze({ use_max: 10000, unlock_min: 100000, unlock_max: 1000000, roy_min: 10, roy_max: 50 });
const NAME_RE = /^[\w .'\-()]{1,40}$/;
const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().replace(/^@/, "").toLowerCase();
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const P = () => require("./premium");
const L = () => require("./likeness");
const SB = () => require("./soundboards");
class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || { 400: "E_BAD_ARGS", 401: "E_NO_PERMISSION", 402: "E_INSUFFICIENT_PAT", 403: "E_NO_PERMISSION", 404: "E_TARGET_NOT_FOUND", 409: "E_ALREADY", 423: "E_FEATURE_OFF" }[status] || "E_REFUSED"; }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS voices (id TEXT PRIMARY KEY, display TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'stock', owner_user_id TEXT, owner_login TEXT,
        price_use INTEGER NOT NULL DEFAULT 0, price_unlock INTEGER NOT NULL DEFAULT 0, royalty_pct REAL NOT NULL DEFAULT 0, listed INTEGER NOT NULL DEFAULT 1,
        allow_free_text INTEGER NOT NULL DEFAULT 1, allow_soundboard INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', consent_id INTEGER,
        consent_manual INTEGER NOT NULL DEFAULT 0, engine TEXT, vb_profile TEXT, sample_clip TEXT, in_voicebox INTEGER NOT NULL DEFAULT 1, created INTEGER, updated INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS voice_owned (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, voice_id TEXT NOT NULL, source TEXT NOT NULL,
        price INTEGER NOT NULL DEFAULT 0, ref TEXT NOT NULL, created INTEGER NOT NULL)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS voice_owned_own ON voice_owned (user_id, voice_id)");
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS voice_owned_ref ON voice_owned (ref)");
      await runQuery("CREATE TABLE IF NOT EXISTS voice_owned_logins (login TEXT NOT NULL, voice_id TEXT NOT NULL, source TEXT, created INTEGER, PRIMARY KEY (login, voice_id))");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const sampleId = (id) => "vs-" + crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 12);
const sampleText = (display) => `Hi, this is ${display}. This is how I sound on PATV.`;
function pub(v, extra) {
  return Object.assign({ id: v.id, display: v.display, kind: v.kind, owner: v.owner_login || null, price_use: v.price_use, price_unlock: v.price_unlock,
    royalty_pct: v.royalty_pct, listed: !!v.listed, allow_free_text: !!v.allow_free_text, allow_soundboard: !!v.allow_soundboard, status: v.status,
    consent_manual: !!v.consent_manual, consented: !!(v.consent_id || v.consent_manual), in_voicebox: !!v.in_voicebox }, extra || {});
}
async function voice(id) { await init(); return (await getQuery("SELECT * FROM voices WHERE id = ?", [low(id)]))[0] || null; }
async function all() { await init(); return getQuery("SELECT * FROM voices ORDER BY kind = 'stock' DESC, display"); }
/** {voice id: owner's Camfrog login} for owned (cloned) voices that are active - the soundboard / pack cuts. */
async function ownerMap() {
  await init();
  const out = {};
  for (const v of await getQuery("SELECT id, owner_login FROM voices WHERE owner_login IS NOT NULL AND owner_login != '' AND status = 'active'")) out[v.id] = low(v.owner_login);
  return out;
}
/** Voices a pad owner may pick for a TTS soundboard clip. */
async function pickable() {
  await init();
  return (await getQuery("SELECT * FROM voices WHERE status = 'active' AND in_voicebox = 1 AND (kind != 'clone' OR (allow_soundboard = 1 AND allow_free_text = 1)) ORDER BY display"))
    .map((v) => ({ id: v.id, display: v.display, kind: v.kind }));
}
async function ensureSample(v) {
  try {
    await SB().init();
    const id = sampleId(v.id);
    const t = now();
    const cur = (await getQuery("SELECT id FROM sb_clips WHERE id = ?", [id]))[0];
    if (!cur) {
      await runQuery(`INSERT INTO sb_clips (id, board, label, emoji, kind, voice, text, rarity, status, created_by, created, updated)
                      VALUES (?, 'sample', ?, '🗣️', 'tts', ?, ?, 'epic', 'render', 'voicestore', ?, ?)`, [id, v.display.slice(0, 32), v.id, sampleText(v.display), t, t]);
    }
    if (v.sample_clip !== id) await runQuery("UPDATE voices SET sample_clip = ? WHERE id = ?", [id, v.id]);
  } catch (e) { console.error("[voicestore] sample:", e.message); }
}

// ── Pepe's import (idempotent; never overwrites a site edit) ──
async function importFromPepe(b) {
  await init();
  const t = now();
  const names = (Array.isArray(b.names) ? b.names : []).map((n) => String(n || "").trim()).filter((n) => NAME_RE.test(n)).slice(0, 500);
  const shop = b.shop && typeof b.shop === "object" ? b.shop : {};
  let added = 0, owners = 0, unlocks = 0;
  const seen = new Set();
  for (const name of names.concat(Object.keys(shop))) {
    const id = low(name);
    if (!id || seen.has(id) || !NAME_RE.test(name)) continue;
    seen.add(id);
    const cfg = shop[name] || shop[id] || {};
    const ownerLogin = low(cfg.owner) || null;
    const cur = await voice(id);
    if (!cur) {
      let ownerId = null;
      if (ownerLogin) { const u = await L().userByLogin(ownerLogin); ownerId = u ? u.userId : null; owners++; }
      const roy = Math.max(0, Math.min(90, Math.round((Number(cfg.royalty) || 0) * 1000) / 10));
      await runQuery(`INSERT INTO voices (id, display, kind, owner_user_id, owner_login, price_use, price_unlock, royalty_pct, listed, allow_free_text, allow_soundboard,
                      status, consent_manual, in_voicebox, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 'active', 0, ?, ?, ?)`,
                     [id, String(name).slice(0, 40), ownerLogin ? "clone" : "stock", ownerId, ownerLogin, Math.max(0, Math.floor(Number(cfg.price) || 0)),
                      Math.max(0, Math.floor(Number(cfg.unlock) || 0)), roy, names.length ? (names.some((n) => low(n) === id) ? 1 : 0) : 1, t, t]);
      added++;
    } else if (names.length) {
      await runQuery("UPDATE voices SET in_voicebox = ? WHERE id = ?", [names.some((n) => low(n) === id) ? 1 : 0, id]);
    }
    await ensureSample(await voice(id));
  }
  if (names.length) {
    const known = new Set(names.map(low));
    for (const v of await getQuery("SELECT id FROM voices WHERE in_voicebox = 1")) if (!known.has(v.id)) await runQuery("UPDATE voices SET in_voicebox = 0 WHERE id = ?", [v.id]);
  }
  const ul = b.unlocks && typeof b.unlocks === "object" ? b.unlocks : {};
  for (const [key, list] of Object.entries(ul)) {
    const login = low(key);
    if (!login) continue;
    const u = await L().userByLogin(login);
    for (const vName of (Array.isArray(list) ? list : []).slice(0, 200)) {
      const vid = low(vName);
      if (!(await voice(vid))) continue;
      if (u) {
        const r = await runQuery("INSERT OR IGNORE INTO voice_owned (user_id, voice_id, source, price, ref, created) VALUES (?, ?, 'import', 0, ?, ?)",
                                 [u.userId, vid, `import:${u.userId}:${vid}`, t]);
        if (r && r.changes) unlocks++;
      } else {
        await runQuery("INSERT OR IGNORE INTO voice_owned_logins (login, voice_id, source, created) VALUES (?, ?, 'import', ?)", [login, vid, t]);
      }
    }
  }
  return { added, owners, unlocks, total: (await getQuery("SELECT COUNT(*) AS n FROM voices"))[0].n };
}

// ── Pepe's sync ──
async function botState() {
  await init();
  const voices = (await all()).map((v) => pub(v, { owner: v.owner_login ? low(v.owner_login) : null }));
  const owned = {};
  for (const r of await getQuery(`SELECT o.voice_id, u.camfrogUsername AS cf FROM voice_owned o JOIN users u ON u.userId = o.user_id
                                  WHERE u.camfrogUsername IS NOT NULL AND u.camfrogUsername != ''`)) (owned[low(r.cf)] = owned[low(r.cf)] || []).push(r.voice_id);
  for (const r of await getQuery("SELECT login, voice_id FROM voice_owned_logins")) (owned[r.login] = owned[r.login] || []).push(r.voice_id);
  return { voices, owned, bands: BANDS };
}

// ── buying an unlock ──
async function buy(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const v = await voice(opts.voice);
  if (!v || v.status !== "active" || !v.listed) throw new Refuse(404, "That voice isn't for sale.");
  if (!(v.price_unlock > 0)) throw new Refuse(400, `${v.display} isn't sold outright` + (v.price_use ? ` - it costs ${fmt(v.price_use)} PAT per use.` : " - it's free to use."));
  if (v.owner_user_id && v.owner_user_id === user.userId) throw new Refuse(409, "It's your own voice - you already use it free.");
  const rawRef = String(opts.ref || "");
  if (!REF_RE.test(rawRef)) throw new Refuse(400, "Bad request (ref).");
  const ref = `vs:${user.userId}:${rawRef}`;
  const price = v.price_unlock;
  const t = now();
  const out = await require("./boosts").tx(async () => {
    const had = (await getQuery("SELECT * FROM voice_owned WHERE ref = ?", [ref]))[0];
    if (had) return { dup: true, row: had };
    if ((await getQuery("SELECT 1 FROM voice_owned WHERE user_id = ? AND voice_id = ?", [user.userId, v.id]))[0]) throw new Refuse(409, `You already own ${v.display}.`);
    const r = await require("./ledger").post(user.userId, -price, `🗣️ voice unlock: ${v.display}`.slice(0, 120), { requireCover: true, transactionId: P().txRef(ref), source: "voicestore" });
    if (!r.ok) throw new Refuse(402, `${v.display} costs ${fmt(price)} PAT - you don't have enough.`);
    let cut = 0;
    if (v.owner_login) {
      cut = await L().siteCut({ key: "voice_unlock", flow: "voice_unlock", base: price, subjects: [v.owner_login], payerId: user.userId,
                                ref: "vsu-" + crypto.createHash("sha256").update(ref).digest("hex").slice(0, 24) });
    }
    const routing = await P().bookRoute("voice_unlock", price - cut, { payerId: user.userId, label: `voice unlock ${v.id}` });
    await runQuery("INSERT INTO voice_owned (user_id, voice_id, source, price, ref, created) VALUES (?, ?, 'buy', ?, ?, ?)", [user.userId, v.id, price, ref, t]);
    return { dup: false, cut, routing };
  });
  if (out.dup) return { dup: true, voice: v.id, price: out.row.price };
  return { dup: false, voice: v.id, display: v.display, price, cut: out.cut };
}
async function owns(userId, id) {
  await init();
  return !!(userId && (await getQuery("SELECT 1 FROM voice_owned WHERE user_id = ? AND voice_id = ?", [userId, low(id)]))[0]);
}

// ── owners ──
async function ownerSummary(userId) {
  await init();
  const voices = await getQuery("SELECT * FROM voices WHERE owner_user_id = ? AND status != 'revoked'", [userId]);
  return { voices: voices.map((v) => pub(v)) };
}
function cleanOwnerPatch(v, b) {
  const out = {};
  const num = (x, lo, hi, what) => {
    const n = Math.floor(Number(x));
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Refuse(400, `${what}: ${fmt(lo)} - ${fmt(hi)}.`);
    return n;
  };
  if (b.price_use !== undefined) out.price_use = num(b.price_use, 0, BANDS.use_max, "Price per use");
  if (b.price_unlock !== undefined) {
    const n = Math.floor(Number(b.price_unlock));
    out.price_unlock = n === 0 ? 0 : num(n, BANDS.unlock_min, BANDS.unlock_max, "Unlock price (or 0: not sold)");
  }
  if (b.royalty_pct !== undefined) out.royalty_pct = num(b.royalty_pct, BANDS.roy_min, BANDS.roy_max, "Your cut (%)");
  for (const k of ["listed", "allow_free_text", "allow_soundboard"]) if (typeof b[k] === "boolean") out[k] = b[k] ? 1 : 0;
  if (b.status === "paused" || b.status === "active") {
    if (!["active", "paused"].includes(v.status)) throw new Refuse(409, "That voice can't be switched now.");
    out.status = b.status;
  }
  return out;
}
async function ownerUpdate(user, id, b) {
  await init();
  const v = await voice(id);
  if (!v || v.status === "revoked") throw new Refuse(404, "No such voice.");
  if (!user || v.owner_user_id !== user.userId) throw new Refuse(403, "Only the voice's owner can change it.");
  return applyPatch(v, cleanOwnerPatch(v, b || {}));
}
async function applyPatch(v, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return pub(v);
  await runQuery(`UPDATE voices SET ${keys.map((k) => k + " = ?").join(", ")}, updated = ? WHERE id = ?`, [...keys.map((k) => patch[k]), now(), v.id]);
  return pub(await voice(v.id));
}
async function adminUpdate(id, b, by) {
  await init();
  const v = await voice(id);
  if (!v) throw new Refuse(404, "No such voice.");
  const patch = {};
  if (b.price_use !== undefined) patch.price_use = Math.max(0, Math.min(BANDS.use_max, Math.floor(Number(b.price_use) || 0)));
  if (b.price_unlock !== undefined) patch.price_unlock = Math.max(0, Math.min(10 * BANDS.unlock_max, Math.floor(Number(b.price_unlock) || 0)));
  if (b.royalty_pct !== undefined) patch.royalty_pct = Math.max(0, Math.min(BANDS.roy_max, Number(b.royalty_pct) || 0));
  for (const k of ["listed", "allow_free_text", "allow_soundboard", "consent_manual"]) if (typeof b[k] === "boolean") patch[k] = b[k] ? 1 : 0;
  if (["active", "paused", "pending"].includes(b.status)) patch.status = b.status;
  if (b.owner !== undefined) {
    const lg = low(b.owner);
    if (!lg) { patch.owner_login = null; patch.owner_user_id = null; patch.kind = v.kind === "clone" ? "stock" : v.kind; }
    else {
      const u = await L().userByLogin(lg);
      patch.owner_login = lg; patch.owner_user_id = u ? u.userId : null; patch.kind = "clone";
    }
  }
  console.log(`[voicestore] ${v.id} edited by ${by}: ${JSON.stringify(patch)}`);
  return applyPatch(v, patch);
}

// ── routes ──
function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[voicestore] init:", e.message));
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "256kb" });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code });
    console.error("[voicestore]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const same = (req, res) => { if (!guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; } return true; };

  app.post("/api/voices/bot/import", json, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try { res.json({ ok: true, ...(await importFromPepe(b)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/voices/bot/sync", json, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try { res.json({ ok: true, ...(await botState()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/voices/bot/buy", json, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      const u = await L().userByLogin(b.camfrog);
      if (!u) return res.status(404).json({ ok: false, error: "no PATV account for that Camfrog name" });
      res.json({ ok: true, ...(await buy({ userId: u.userId, username: u.username }, { voice: b.voice, ref: String(b.ref || "").slice(0, 64) })) });
    } catch (e) { fail(res, e); }
  });

  const pageData = async (user) => {
    await init();
    const uid = user && user.userId;
    const mine = uid ? new Set((await getQuery("SELECT voice_id FROM voice_owned WHERE user_id = ?", [uid])).map((r) => r.voice_id)) : new Set();
    const rows = (await all()).filter((v) => v.status === "active" && v.listed && v.in_voicebox);
    const clips = {};
    try {
      await SB().init();
      for (const c of await getQuery("SELECT id, audio, sha, status FROM sb_clips WHERE board = 'sample'")) clips[c.id] = c;
    } catch (e) { /* no samples yet */ }
    return { signed: !!uid, voices: rows.map((v) => {
      const c = clips[v.sample_clip || sampleId(v.id)];
      return pub(v, { owned: mine.has(v.id) || (uid && v.owner_user_id === uid), mine: !!(uid && v.owner_user_id === uid),
                      sample: c && c.status === "active" && c.audio ? `/sb/audio/${c.id}.wav?v=${String(c.sha || "").slice(0, 8)}` : null,
                      free: !(v.price_use > 0) });
    }) };
  };
  // 1.99ta: "Clone your voice" on the store page while !clonemyvoice is switched on (voiceclone.js)
  const cloneOn = () => { try { return !!require("./voiceclone").config().enabled; } catch (e) { return false; } };
  app.get("/voices", addUser, async (req, res, next) => {
    try { res.set("Cache-Control", "private, no-store"); res.render("voices", { user: req.user ? req.user.username : null, d: await pageData(req.user), mine: null, cloneOn: cloneOn() }); } catch (e) { next(e); }
  });
  app.get("/api/voices", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await pageData(req.user)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/voices/buy", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!same(req, res)) return;
    try { const b = req.body || {}; res.json({ ok: true, ...(await buy(req.user, { voice: b.voice, ref: b.ref })), state: await pageData(req.user) }); } catch (e) { fail(res, e); }
  });
  app.get("/voices/mine", addUser, async (req, res, next) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/voices/mine"));
      res.set("Cache-Control", "private, no-store");
      const mine = await ownerSummary(req.user.userId);
      let clone = null;
      try { clone = await require("./voiceclone").status(req.user.userId); } catch (e) { clone = null; }
      res.render("voices", { user: req.user.username, d: await pageData(req.user), mine, clone, bands: BANDS, lk: await L().status(req.user.userId) });
    } catch (e) { next(e); }
  });
  app.post("/api/voices/mine", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!same(req, res)) return;
    try { const b = req.body || {}; res.json({ ok: true, voice: await ownerUpdate(req.user, b.voice, b) }); } catch (e) { fail(res, e); }
  });
  // staff
  app.get("/api/voices/admin", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !["Admin", "Staff"].includes(req.user.class)) return res.status(403).json({ ok: false });
    try { res.json({ ok: true, voices: (await all()).map((v) => pub(v)), bands: BANDS }); } catch (e) { fail(res, e); }
  });
  app.post("/api/voices/admin", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!same(req, res)) return;
    if (!req.user || req.user.class !== "Admin") return res.status(403).json({ ok: false, error: "Admins only." });
    try { const b = req.body || {}; res.json({ ok: true, voice: await adminUpdate(b.voice, b, req.user.username) }); } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, voice, all, ownerMap, pickable, importFromPepe, botState, buy, owns, ownerSummary, ownerUpdate, adminUpdate, applyPatch, register, sampleId, BANDS, Refuse,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
