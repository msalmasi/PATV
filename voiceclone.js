// voiceclone.js — 🎙️ !clonemyvoice: consent-based voice cloning (1.99ri; soundboards design S3, the user's decisions of 2026-10-11;
// the consent flow was reviewed by counsel and cloning is launched - the feature switch defaults ON).
//
// Only your own voice, opt-in only, deletable any time. The flow:
//   1. `!clonemyvoice` in a Camfrog room -> Pepe asks /api/voiceclone/bot/start: the Camfrog login must be linked to a real
//      (signed-in) PATV account, not banned, one clone per person -> Pepe PMs the link to /voices/clone.
//   2. /voices/clone (signed in as that account): plain-language terms (what it is, where it's stored, royalties, revocation,
//      deletion), an 18+ attestation, a consent checkbox and the Camfrog login typed out -> a voice_consents row with a ONE-TIME
//      phrase ("I am <login>, and I consent to PATV cloning my voice. Code 4-7-2-9.") and a ~40 s script, valid 15 minutes.
//   3. In a room: the person takes the mic ALONE and reads the phrase, then the script, in ONE turn. Pepe (pepe_voiceclone.py)
//      checks the turn: at least 30 s, nobody else on the mic at any moment of it, STT of the turn (phrase words >= 85% and
//      the exact code, script words >= 80%), and an in-memory same-speaker comparison of the start vs the rest (spectral
//      statistics - nothing is stored, no voiceprint: BIPA / GDPR). The WAV of the turn comes here as the consent audio.
//   4. Failed checks: retry (3 a day). Passed: AUTO-APPROVED when the account is 30+ days old, level 5+ and confirmed 18+
//      (D11) and the same-speaker check passed; anyone else goes to staff review (/admin/soundboards#clones: listen, approve
//      or deny).
//   5. Approved -> Pepe creates the VoiceBox profile on the primary host (CT 100; the hourly sync copies it to Thor 2) and
//      reports it -> a voices row (voicestore.js): kind clone, owned by the person, NOT listed until they list it, others'
//      free text OFF (D12), soundboards on, 30% cut, per-use 1,000.
//   6. Revoke any time (web button or `!clonemyvoice delete`; staff can too): the voice stops at once (status revoked: !say,
//      soundboards, packs, the random pool), soundboard clips in it are removed, Pepe deletes the profile + samples on BOTH
//      VoiceBox hosts (delete jobs until both confirm), unlock buyers get 50% of their price back from the Reserve (D9; the
//      funding flow voice_refund), the consent audio is deleted 30 days later; the consent row stays (proof of consent and of
//      revocation). Existing voices cloned before this (D10) are kept as they are.
//
//   voice_consents   id, user_id, login, status (phrase|review|approved|active|denied|revoked|expired|failed), terms_version,
//                    attested_18, typed_login, phrase, code, script, issued_at, expires_at, attempts, attempts_day, audio,
//                    audio_sha, stt_text, phrase_score, code_ok, script_score, single_holder, same_speaker, secs, checks,
//                    ip_hash, ua_hash, created, decided_at, reviewed_by, decision_reason, auto_approved, voice_id, vb_profile,
//                    vb_deleted (JSON {host: at}), revoked_at, revoke_reason, revoked_by, audio_deleted_at
//   voiceclone_config  key/value
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");

const DIR = process.env.VC_DIR ? path.resolve(process.env.VC_DIR) : path.join(__dirname, "uploads", "voiceclone");
const TERMS_VERSION = "2026-10-11";
const DEFAULTS = Object.freeze({
  enabled: true,            // the user, 2026-10-11: counsel reviewed the flow - cloning is launched (prod included)
  auto_min_age_days: 30, auto_min_level: 5,
  phrase_ttl_min: 15, attempts_per_day: 3, min_secs: 30,
  phrase_score_min: 85, script_score_min: 80, same_speaker_min: 95,   // same speaker: a coarse spectral heuristic - below 95 a human listens
  audio_keep_days: 30, default_price_use: 1000, default_royalty_pct: 30,
});
const SCRIPTS = Object.freeze([
  "The quick brown fox jumps over the lazy dog, and the sleepy frog in the pond just watches it happen. Every evening the radio plays an old song about the river, the rain and the long road home. I like my coffee strong, my music loud and my friends even louder. Today is a good day to read something out loud, slowly and clearly, from the very first word to the very last.",
  "A little frog sat on a lily pad and counted the stars one by one: seven, eight, nine, ten. The wind moved through the tall grass, and somewhere a dog barked twice. Bright lights, busy streets and a warm kitchen at midnight - that's what I think of when I think of the city. Thank you for listening to me read this whole paragraph from start to finish.",
  "On Monday the bakery opens early, and the smell of fresh bread fills the whole block. My favorite color is green, my favorite season is autumn, and my favorite sound is rain on a tin roof. If you ever visit the coast, bring a jacket, a good book and plenty of patience for the slow ferry. Now I'm reading the last sentence of this short story, nice and clear.",
]);
const NUM_WORDS = { zero: "0", oh: "0", one: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4", five: "5", six: "6", seven: "7", eight: "8", ate: "8", nine: "9" };
const LOGIN_RE = /^[\w.\-]{1,40}$/;
let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().replace(/^@/, "").toLowerCase();
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const VS = () => require("./voicestore");
const L = () => require("./likeness");
class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || { 400: "E_BAD_ARGS", 401: "E_NO_PERMISSION", 403: "E_NO_PERMISSION", 404: "E_TARGET_NOT_FOUND", 409: "E_ALREADY", 423: "E_FEATURE_OFF", 429: "E_RATE_LIMITED" }[status] || "E_REFUSED"; }
}

let CONFIG = Object.assign({}, DEFAULTS);
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      fs.mkdirSync(DIR, { recursive: true });
      await runQuery(`CREATE TABLE IF NOT EXISTS voice_consents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, login TEXT NOT NULL, status TEXT NOT NULL,
        terms_version TEXT, attested_18 INTEGER, typed_login TEXT, phrase TEXT, code TEXT, script TEXT, issued_at INTEGER, expires_at INTEGER, attempts INTEGER DEFAULT 0,
        attempts_day TEXT, audio TEXT, audio_sha TEXT, stt_text TEXT, phrase_score REAL, code_ok INTEGER, script_score REAL, single_holder INTEGER, same_speaker REAL,
        secs REAL, checks TEXT, ip_hash TEXT, ua_hash TEXT, created INTEGER NOT NULL, decided_at INTEGER, reviewed_by TEXT, decision_reason TEXT,
        auto_approved INTEGER DEFAULT 0, voice_id TEXT, vb_profile TEXT, vb_deleted TEXT, revoked_at INTEGER, revoke_reason TEXT, revoked_by TEXT, audio_deleted_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS voice_consents_user ON voice_consents (user_id, status)");
      await runQuery("CREATE TABLE IF NOT EXISTS voiceclone_config (key TEXT PRIMARY KEY, value TEXT)");
      const o = {};
      for (const r of await getQuery("SELECT key, value FROM voiceclone_config")) { try { o[r.key] = JSON.parse(r.value); } catch (e) { /* skip */ } }
      CONFIG = cleanConfig(Object.assign({}, DEFAULTS, o));
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
function cleanConfig(c) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    if (typeof d === "boolean") out[k] = c[k] === undefined ? d : c[k] !== false;
    else { const n = Number(c[k]); out[k] = Number.isFinite(n) && n >= 0 ? Math.min(1e7, n) : d; }
  }
  return out;
}
async function setConfig(patch, actor) {
  await init();
  CONFIG = cleanConfig(Object.assign({}, CONFIG, patch || {}));
  for (const [k, v] of Object.entries(CONFIG)) await runQuery("INSERT INTO voiceclone_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(v)]);
  console.log(`[voiceclone] config changed by ${actor || "?"}`);
  return CONFIG;
}
const config = () => CONFIG;
const hash = (s) => crypto.createHash("sha256").update("vc:" + String(s || "")).digest("hex").slice(0, 24);

// ── who ──
const OPEN = ["phrase", "review", "approved", "active"];
async function accountOf(login) {
  const l = low(login);
  if (!LOGIN_RE.test(l)) return null;
  // a real account (one that can sign in): never Pepe's auto-made "CF..." accounts
  return (await getQuery(`SELECT userId, username, class, level, created_at, camfrogUsername, casino_banned FROM users
                          WHERE lower(camfrogUsername) = ? AND username NOT LIKE 'CF%' ORDER BY created_at LIMIT 1`, [l]))[0] || null;
}
async function current(userId) {
  await init();
  return (await getQuery(`SELECT * FROM voice_consents WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [userId]))[0] || null;
}
async function refusal(u) {
  if (!CONFIG.enabled) return "Voice cloning is switched off right now.";
  if (!u) return "link your Camfrog name to a PATV account first (!verify), then sign in on the website";
  if (u.class === "Banned") return "this account can't clone a voice";
  const open = (await getQuery(`SELECT status FROM voice_consents WHERE user_id = ? AND status IN (${OPEN.map(() => "?").join(",")})`, [u.userId, ...OPEN]))[0];
  if (open && open.status !== "phrase") return open.status === "active" ? "you already have a cloned voice - one per person" : "your voice is already being reviewed";
  try {
    const own = (await getQuery("SELECT id FROM voices WHERE owner_user_id = ? AND status != 'revoked' LIMIT 1", [u.userId]))[0];
    if (own) return "you already have a voice in the store - one per person";
  } catch (e) { /* no voice store yet */ }
  return null;
}
const createdMs = (u) => { const t = Date.parse(String(u.created_at || "").replace(" ", "T") + (/[zZ+]/.test(String(u.created_at || "")) ? "" : "Z")); return Number.isFinite(t) ? t : 0; };
function autoEligible(u, c) {
  return !!(u && c && c.attested_18 && now() - createdMs(u) >= CONFIG.auto_min_age_days * 86400000 && Number(u.level || 0) >= CONFIG.auto_min_level);
}

// ── step 2: consent on the website ──
async function consent(user, b, req) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const u = (await getQuery("SELECT userId, username, class, level, created_at, camfrogUsername FROM users WHERE userId = ?", [user.userId]))[0];
  if (!u || !u.camfrogUsername) throw new Refuse(403, "Link your Camfrog name first: type !verify in a Camfrog room with Pepe.");
  const why = await refusal(u);
  if (why) throw new Refuse(409, why.charAt(0).toUpperCase() + why.slice(1) + ".");
  if (b.attest18 !== true) throw new Refuse(400, "Cloning is for adults only - confirm you're 18 or older.");
  if (b.consent !== true) throw new Refuse(400, "Tick the consent box to go on.");
  if (low(b.typed_login) !== low(u.camfrogUsername)) throw new Refuse(400, "Type your Camfrog name exactly as it is.");
  const t = now();
  const code = String(crypto.randomInt(1000, 10000));
  const login = low(u.camfrogUsername);
  const phrase = `I am ${login}, and I consent to PATV cloning my voice. Code ${code.split("").join("-")}.`;
  const script = SCRIPTS[crypto.randomInt(0, SCRIPTS.length)];
  await runQuery("UPDATE voice_consents SET status = 'expired' WHERE user_id = ? AND status = 'phrase'", [u.userId]);
  const prev = (await getQuery("SELECT attempts, attempts_day FROM voice_consents WHERE user_id = ? ORDER BY id DESC LIMIT 1", [u.userId]))[0];
  const attempts = prev && prev.attempts_day === dayOf(t) ? prev.attempts : 0;
  if (attempts >= CONFIG.attempts_per_day) throw new Refuse(429, `That's ${attempts} tries today - try again tomorrow.`);
  await runQuery(`INSERT INTO voice_consents (user_id, login, status, terms_version, attested_18, typed_login, phrase, code, script, issued_at, expires_at, attempts,
                  attempts_day, ip_hash, ua_hash, created) VALUES (?, ?, 'phrase', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [u.userId, login, TERMS_VERSION, String(b.typed_login).slice(0, 40), phrase, code, script, t, t + CONFIG.phrase_ttl_min * 60000, attempts, dayOf(t),
                  hash(req && (req.headers["x-forwarded-for"] || req.ip)), hash(req && req.get && req.get("user-agent")), t]);
  return status(u.userId);
}

// ── step 3/4: Pepe recorded the turn ──
function words(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).map((w) => NUM_WORDS[w] || w);
}
/** How much of `want` the transcript `got` contains (0-100), order-insensitive with repeats counted. */
function coverage(want, got) {
  const w = words(want), g = words(got);
  if (!w.length) return 0;
  const bag = new Map();
  for (const x of g) bag.set(x, (bag.get(x) || 0) + 1);
  // 1.99wm: STT spells some words out - "foamy1111" comes back as "Foamy One One One One", "PATV" as "P A T V". A word of 4+
  // characters the bag misses still counts when the transcript, squashed (number words -> digits, no spaces), contains it.
  const squashed = g.join("");
  let hit = 0;
  for (const x of w) {
    const n = bag.get(x) || 0;
    if (n > 0) { hit++; bag.set(x, n - 1); } else if (x.length >= 4 && squashed.includes(x)) hit++;
  }
  return Math.round((hit / w.length) * 1000) / 10;
}
/** The site's own scoring of Pepe's transcript (Pepe's numbers are advisory; these decide). */
function score(c, text) {
  const phraseWords = c.phrase.replace(/Code [\d-]+\.?$/, "");
  const digits = words(text).join(" ").replace(/\b(\d)\s+(?=\d\b)/g, "$1").replace(/\s+/g, " ");
  const code_ok = digits.includes(c.code) || words(text).join("").includes(c.code);
  return { phrase_score: coverage(phraseWords, text), code_ok, script_score: coverage(c.script, text) };
}
async function recorded(b) {
  await init();
  const c = (await getQuery("SELECT * FROM voice_consents WHERE id = ?", [Math.floor(Number(b.id) || 0)]))[0];
  if (!c || c.status !== "phrase") throw new Refuse(404, "no recording is expected for that");
  if (low(b.login) !== c.login) throw new Refuse(403, "the speaker isn't the person who consented");
  const t = now();
  if (t > c.expires_at) {
    await runQuery("UPDATE voice_consents SET status = 'expired' WHERE id = ?", [c.id]);
    throw new Refuse(410, "the phrase expired - start again on the website");
  }
  const buf = Buffer.from(String(b.audio || ""), "base64");
  if (buf.length < 44 || buf.slice(0, 4).toString() !== "RIFF" || buf.length > 8 * 1024 * 1024) throw new Refuse(400, "bad audio");
  const sc = score(c, b.stt_text);
  const secs = Number(b.secs) || 0;
  const single = b.single_holder === true;
  const same = Number(b.same_speaker);
  const fails = [];
  if (secs < CONFIG.min_secs) fails.push(`the turn was ${Math.round(secs)} s - read the whole script (at least ${CONFIG.min_secs} s)`);
  if (!single) fails.push("someone else was on the mic during your turn - take it alone");
  if (sc.phrase_score < CONFIG.phrase_score_min) fails.push("I couldn't hear the consent phrase clearly");
  if (!sc.code_ok) fails.push("I didn't hear the code");
  if (sc.script_score < CONFIG.script_score_min) fails.push("I couldn't hear enough of the script");
  const checks = JSON.stringify({ secs, single, phrase: sc.phrase_score, code: sc.code_ok, script: sc.script_score, same_speaker: Number.isFinite(same) ? same : null,
                                  pepe: { phrase: b.phrase_score, script: b.script_score } });
  const attempts = (c.attempts_day === dayOf(t) ? c.attempts : 0) + 1;
  if (fails.length) {
    const left = CONFIG.attempts_per_day - attempts;
    await runQuery("UPDATE voice_consents SET attempts = ?, attempts_day = ?, checks = ?, stt_text = ?, status = ? WHERE id = ?",
                   [attempts, dayOf(t), checks, String(b.stt_text || "").slice(0, 4000), left > 0 ? "phrase" : "failed", c.id]);
    return { ok: false, passed: false, fails, attempts_left: Math.max(0, left) };
  }
  fs.mkdirSync(DIR, { recursive: true });
  const file = `consent-${c.id}-${crypto.randomBytes(6).toString("hex")}.wav`;
  fs.writeFileSync(path.join(DIR, file), buf);
  const u = (await getQuery("SELECT userId, level, created_at FROM users WHERE userId = ?", [c.user_id]))[0];
  const sameOk = Number.isFinite(same) && same >= CONFIG.same_speaker_min;
  const auto = autoEligible(u, c) && sameOk;
  await runQuery(`UPDATE voice_consents SET status = ?, audio = ?, audio_sha = ?, stt_text = ?, phrase_score = ?, code_ok = 1, script_score = ?, single_holder = 1,
                  same_speaker = ?, secs = ?, checks = ?, attempts = ?, attempts_day = ?, decided_at = ?, auto_approved = ?, reviewed_by = ?, decision_reason = ? WHERE id = ?`,
                 [auto ? "approved" : "review", file, crypto.createHash("sha256").update(buf).digest("hex"), String(b.stt_text || "").slice(0, 4000), sc.phrase_score,
                  sc.script_score, Number.isFinite(same) ? same : null, secs, checks, attempts, dayOf(t), auto ? t : null, auto ? 1 : 0, auto ? "auto" : null,
                  auto ? "auto-approved: 30+ days, level 5+, 18+ confirmed, every check passed" : (sameOk ? "staff review (account age / level)" : "staff review (same-speaker check)"),
                  c.id]);
  notify(c.user_id, auto ? "✅ Your voice passed every check" : "🕵️ Your voice is waiting for a quick review",
         auto ? "Pepe is creating it now - it shows up on /voices/mine in a few minutes, unlisted until you list it."
              : "A staff member listens to the recording and approves it - usually within a day.", "vc-rec:" + c.id);
  return { ok: true, passed: true, status: auto ? "approved" : "review" };
}

// ── step 5: Pepe created the profile ──
async function created(b) {
  await init();
  const c = (await getQuery("SELECT * FROM voice_consents WHERE id = ?", [Math.floor(Number(b.id) || 0)]))[0];
  if (!c || c.status !== "approved") throw new Refuse(404, "nothing approved to create");
  const name = String(b.name || c.login).trim().slice(0, 40);
  const vid = low(name);
  await VS().init();
  const t = now();
  const exists = await VS().voice(vid);
  if (exists && exists.owner_user_id !== c.user_id) throw new Refuse(409, "a different voice already has that name");
  // 🦜 1.99wn: the achievements' one-off quiet backfill of the voices cloned before it runs BEFORE this one goes active (else this
  // clone would be counted in it, quietly); never blocks the creation
  try { await require("./achievements").voiceBackfill(); } catch (e) { /* the award is retried by any later check */ }
  if (exists) {
    await runQuery(`UPDATE voices SET kind = 'clone', owner_user_id = ?, owner_login = ?, status = 'active', consent_id = ?, vb_profile = ?, in_voicebox = 1, updated = ? WHERE id = ?`,
                   [c.user_id, c.login, c.id, String(b.profile_id || "").slice(0, 80), t, vid]);
  } else {
    await runQuery(`INSERT INTO voices (id, display, kind, owner_user_id, owner_login, price_use, price_unlock, royalty_pct, listed, allow_free_text, allow_soundboard, status,
                    consent_id, engine, vb_profile, in_voicebox, created, updated) VALUES (?, ?, 'clone', ?, ?, ?, 0, ?, 0, 0, 1, 'active', ?, ?, ?, 1, ?, ?)`,
                   [vid, name, c.user_id, c.login, CONFIG.default_price_use, CONFIG.default_royalty_pct, c.id, String(b.engine || "").slice(0, 40) || null,
                    String(b.profile_id || "").slice(0, 80), t, t]);
  }
  await runQuery("UPDATE voice_consents SET status = 'active', voice_id = ?, vb_profile = ? WHERE id = ?", [vid, String(b.profile_id || "").slice(0, 80), c.id]);
  notify(c.user_id, "🎙️ Your voice is ready", "Try it: !say -v " + name + " hello. It's unlisted until you list it on /voices/mine - you set the prices and your cut.", "vc-made:" + c.id);
  // 🦜 Voice of the Pond: XP + PAT (incentive budget, achievements group) + Pepe's room announcement via the achievement feed
  try { require("./achievements").poke(c.user_id); } catch (e) { /* never blocks */ }
  return { ok: true, voice: vid };
}
async function createFailed(b) {
  await init();
  await runQuery("UPDATE voice_consents SET decision_reason = ? WHERE id = ? AND status = 'approved'", [("VoiceBox: " + String(b.why || "failed")).slice(0, 200), Math.floor(Number(b.id) || 0)]);
  return { ok: true };
}

// ── staff review ──
async function decide(id, action, by, reason) {
  await init();
  const c = (await getQuery("SELECT * FROM voice_consents WHERE id = ?", [Math.floor(Number(id) || 0)]))[0];
  if (!c) throw new Refuse(404, "No such clone.");
  const t = now();
  if (action === "approve") {
    if (c.status !== "review") throw new Refuse(409, "Only a clone waiting for review can be approved.");
    await runQuery("UPDATE voice_consents SET status = 'approved', decided_at = ?, reviewed_by = ?, decision_reason = ? WHERE id = ?", [t, by, String(reason || "approved").slice(0, 200), c.id]);
    notify(c.user_id, "✅ Your voice was approved", "Pepe is creating it now - it shows up on /voices/mine in a few minutes.", "vc-ok:" + c.id);
    return { status: "approved" };
  }
  if (action === "deny") {
    if (!["review", "approved"].includes(c.status)) throw new Refuse(409, "Only a clone waiting for review can be denied.");
    await runQuery("UPDATE voice_consents SET status = 'denied', decided_at = ?, reviewed_by = ?, decision_reason = ? WHERE id = ?", [t, by, String(reason || "denied").slice(0, 200), c.id]);
    notify(c.user_id, "Your voice clone wasn't approved", String(reason || "Staff couldn't approve it.") + " The recording is deleted within 30 days.", "vc-no:" + c.id);
    return { status: "denied" };
  }
  if (action === "revoke") return revoke(c.user_id, by, reason || "revoked by staff", c.id);
  throw new Refuse(400, "approve | deny | revoke");
}

// ── step 6: revocation ──
async function revoke(userId, by, reason, consentId) {
  await init();
  const rows = consentId
    ? await getQuery("SELECT * FROM voice_consents WHERE id = ?", [consentId])
    : await getQuery(`SELECT * FROM voice_consents WHERE user_id = ? AND status IN ('phrase','review','approved','active') ORDER BY id DESC`, [userId]);
  if (!rows.length) throw new Refuse(404, "There's no cloned voice to delete.");
  const t = now();
  let refunds = 0, voice = null;
  for (const c of rows) {
    await runQuery("UPDATE voice_consents SET status = 'revoked', revoked_at = ?, revoke_reason = ?, revoked_by = ? WHERE id = ?",
                   [t, String(reason || "revoked by the owner").slice(0, 200), String(by || "owner").slice(0, 60), c.id]);
    if (c.voice_id) {
      voice = c.voice_id;
      await VS().init();
      await runQuery("UPDATE voices SET status = 'revoked', listed = 0, updated = ? WHERE id = ?", [t, c.voice_id]);
      try {
        await runQuery("UPDATE sb_clips SET status = 'removed', note = 'the voice was deleted by its owner', updated = ? WHERE LOWER(voice) = ? AND status != 'removed'", [t, c.voice_id]);
      } catch (e) { /* no soundboards */ }
      refunds += await refundBuyers(c.voice_id, c.id);
    }
  }
  return { revoked: rows.length, voice, refunds };
}
/** D9: unlock buyers of a revoked voice get 50% back from the Reserve (funding flow voice_refund); once per buyer. */
async function refundBuyers(voiceId, consentId) {
  const funding = require("./funding");
  let n = 0;
  const rows = await getQuery("SELECT user_id, price, ref FROM voice_owned WHERE voice_id = ? AND source = 'buy' AND price > 0", [voiceId]);
  for (const r of rows) {
    const half = Math.floor(r.price / 2);
    const type = `🗣️ voice deleted by its owner - half your unlock back (${voiceId}, #${consentId})`;
    if ((await getQuery("SELECT 1 FROM transactions WHERE userId = ? AND type = ? LIMIT 1", [r.user_id, type])).length) continue;
    if ((await getQuery("SELECT 1 FROM reserve_claims WHERE userId = ? AND type = ? LIMIT 1", [r.user_id, type])).length) continue;
    try { if (await funding.fundPayout(r.user_id, half, "voice_refund", type)) n++; } catch (e) { console.error("[voiceclone] refund:", e.message); }
  }
  return n;
}

// ── Pepe's sync: who to listen for, what to create / delete ──
async function botState() {
  await init();
  const t = now();
  await runQuery("UPDATE voice_consents SET status = 'expired' WHERE status = 'phrase' AND expires_at < ?", [t]);
  const armed = (await getQuery("SELECT id, login, phrase, code, script, expires_at, issued_at FROM voice_consents WHERE status = 'phrase'"))
    .map((c) => ({ id: c.id, login: c.login, phrase: c.phrase, code: c.code, script: c.script, expires_at: c.expires_at, issued_at: c.issued_at }));
  const create = (await getQuery("SELECT id, login, stt_text FROM voice_consents WHERE status = 'approved' LIMIT 3"))
    .map((c) => ({ id: c.id, login: c.login, name: c.login, audio: `/api/voiceclone/bot/audio/${c.id}`, reference_text: c.stt_text || "" }));
  const del = (await getQuery("SELECT id, login, voice_id, vb_profile, vb_deleted FROM voice_consents WHERE status = 'revoked' AND voice_id IS NOT NULL"))
    .filter((c) => { const d = parseJson(c.vb_deleted); return !(d.primary && d.fallback); })
    .map((c) => ({ id: c.id, name: c.voice_id, profile_id: c.vb_profile, done: Object.keys(parseJson(c.vb_deleted)) }));
  return { on: CONFIG.enabled, armed, create, delete: del, cfg: { min_secs: CONFIG.min_secs, phrase_score_min: CONFIG.phrase_score_min,
           script_score_min: CONFIG.script_score_min, same_speaker_min: CONFIG.same_speaker_min } };
}
function parseJson(s) { try { return JSON.parse(s || "{}") || {}; } catch (e) { return {}; } }
async function deleted(b) {
  await init();
  const c = (await getQuery("SELECT * FROM voice_consents WHERE id = ?", [Math.floor(Number(b.id) || 0)]))[0];
  if (!c || c.status !== "revoked") throw new Refuse(404, "nothing to delete");
  const d = parseJson(c.vb_deleted);
  for (const h of ["primary", "fallback"]) if ((b.hosts || []).includes(h)) d[h] = d[h] || now();
  await runQuery("UPDATE voice_consents SET vb_deleted = ? WHERE id = ?", [JSON.stringify(d), c.id]);
  if (d.primary && d.fallback) {
    try { await runQuery("UPDATE voices SET in_voicebox = 0 WHERE id = ?", [c.voice_id]); } catch (e) { /* none */ }
    notify(c.user_id, "🗑️ Your cloned voice is deleted", "It's gone from both voice servers. We keep the consent record (that you consented, and that you withdrew it); the recording is deleted within 30 days.", "vc-del:" + c.id);
  }
  return { ok: true, deleted: d };
}

// ── retention: consent audio 30 days after a revocation / denial / failure ──
async function sweep() {
  await init();
  const cut = now() - CONFIG.audio_keep_days * 86400000;
  const rows = await getQuery(`SELECT id, audio FROM voice_consents WHERE audio IS NOT NULL AND audio_deleted_at IS NULL AND
                               ((status = 'revoked' AND revoked_at < ?) OR (status IN ('denied','failed','expired') AND COALESCE(decided_at, created) < ?))`, [cut, cut]);
  for (const r of rows) {
    try { fs.unlinkSync(path.join(DIR, r.audio)); } catch (e) { /* already gone */ }
    await runQuery("UPDATE voice_consents SET audio = NULL, audio_deleted_at = ? WHERE id = ?", [now(), r.id]);
  }
  return rows.length;
}

// ── reads ──
async function status(userId) {
  await init();
  const c = await current(userId);
  const u = (await getQuery("SELECT userId, username, class, level, created_at, camfrogUsername FROM users WHERE userId = ?", [userId]))[0];
  const why = u ? await refusal(Object.assign({}, u, { camfrogUsername: u.camfrogUsername })) : "Sign in first";
  const live = c && c.status === "phrase" && c.expires_at > now();
  return { enabled: CONFIG.enabled, linked: !!(u && u.camfrogUsername), login: u ? low(u.camfrogUsername) : null, can_start: !why || (c && c.status === "phrase"), why: why || null,
           auto: u ? { age_ok: now() - createdMs(u) >= CONFIG.auto_min_age_days * 86400000, level_ok: Number(u.level || 0) >= CONFIG.auto_min_level,
                       days: CONFIG.auto_min_age_days, level: CONFIG.auto_min_level } : null,
           consent: c ? { id: c.id, status: c.status, phrase: live ? c.phrase : null, script: live ? c.script : null, expires_at: live ? c.expires_at : null,
                          created: c.created, decided_at: c.decided_at, reason: c.decision_reason, voice: c.voice_id, attempts: c.attempts,
                          checks: parseJson(c.checks) } : null,
           terms_version: TERMS_VERSION, cfg: { min_secs: CONFIG.min_secs, ttl: CONFIG.phrase_ttl_min, tries: CONFIG.attempts_per_day } };
}
async function record(userId) {
  await init();
  return (await getQuery(`SELECT id, login, status, terms_version, attested_18, typed_login, phrase, issued_at, created, decided_at, reviewed_by, decision_reason,
                          auto_approved, voice_id, revoked_at, revoke_reason, revoked_by, audio_sha, audio_deleted_at, checks FROM voice_consents WHERE user_id = ? ORDER BY id`, [userId]));
}
async function adminRows() {
  await init();
  const rows = await getQuery(`SELECT c.*, u.username FROM voice_consents c LEFT JOIN users u ON u.userId = c.user_id
                               WHERE c.status != 'expired' ORDER BY CASE c.status WHEN 'review' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, c.id DESC LIMIT 100`);
  return rows.map((c) => ({ id: c.id, username: c.username, login: c.login, status: c.status, why: c.decision_reason, checks: c.checks, created: c.created,
                            audio: c.audio ? `/api/voiceclone/audio/${c.id}` : null, voice: c.voice_id, auto: !!c.auto_approved }));
}
function notify(userId, title, body, ref) {
  try { require("./inbox").addSafe(userId, { kind: "system", title, body, link: "/voices/mine", ref }).catch(() => {}); } catch (e) { /* a notice never blocks */ }
}

// ── routes ──
function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[voiceclone] init:", e.message));
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "64kb" });
  const big = express.json({ limit: "12mb" });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code });
    console.error("[voiceclone]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const same = (req, res) => { if (!guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; } return true; };
  const staff = (u) => !!u && ["Admin", "Staff"].includes(u.class);
  const bot = (req, res) => { if (!isBotToken((req.body || {}).password)) { res.status(403).json({ ok: false }); return false; } return true; };

  // Pepe
  app.post("/api/voiceclone/bot/start", json, async (req, res) => {
    if (!bot(req, res)) return;
    try {
      await init();
      const u = await accountOf(req.body.camfrog);
      const why = await refusal(u);
      if (why) return res.json({ ok: false, error: why });
      res.json({ ok: true, url: "/voices/clone" });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/voiceclone/bot/status", json, async (req, res) => {
    if (!bot(req, res)) return;
    try {
      const u = await accountOf(req.body.camfrog);
      if (!u) return res.json({ ok: false, error: "link your Camfrog name to a PATV account first (!verify)" });
      res.json({ ok: true, ...(await status(u.userId)) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/voiceclone/bot/revoke", json, async (req, res) => {
    if (!bot(req, res)) return;
    try {
      const u = await accountOf(req.body.camfrog);
      if (!u) return res.json({ ok: false, error: "no PATV account for that Camfrog name" });
      res.json({ ok: true, ...(await revoke(u.userId, "owner (chat)", "deleted with !clonemyvoice delete")) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/voiceclone/bot/sync", json, async (req, res) => {
    if (!bot(req, res)) return;
    try { await sweep(); res.json({ ok: true, ...(await botState()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/voiceclone/bot/recorded", big, async (req, res) => {
    if (!bot(req, res)) return;
    try { res.json(await recorded(req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/voiceclone/bot/created", json, async (req, res) => {
    if (!bot(req, res)) return;
    try { res.json(req.body.failed ? await createFailed(req.body) : await created(req.body)); } catch (e) { fail(res, e); }
  });
  app.post("/api/voiceclone/bot/deleted", json, async (req, res) => {
    if (!bot(req, res)) return;
    try { res.json(await deleted(req.body || {})); } catch (e) { fail(res, e); }
  });
  app.get("/api/voiceclone/bot/audio/:id", async (req, res) => {
    if (!isBotToken(req.get("x-bot-token"))) return res.status(403).end();
    try {
      const c = (await getQuery("SELECT audio, status FROM voice_consents WHERE id = ?", [Math.floor(Number(req.params.id) || 0)]))[0];
      if (!c || !c.audio || c.status !== "approved") return res.status(404).end();
      res.sendFile(path.join(DIR, c.audio));
    } catch (e) { res.status(500).end(); }
  });

  // the person
  app.get("/voices/clone", addUser, async (req, res, next) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/voices/clone"));
      res.set("Cache-Control", "private, no-store");
      res.render("voiceClone", { user: req.user.username, st: await status(req.user.userId) });
    } catch (e) { next(e); }
  });
  app.get("/api/voiceclone/me", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await status(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/voiceclone/consent", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!same(req, res)) return;
    try { res.json({ ok: true, ...(await consent(req.user, req.body || {}, req)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/voiceclone/revoke", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!same(req, res)) return;
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await revoke(req.user.userId, "owner (web)", "deleted by the owner")) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/voiceclone/record", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      res.set("Content-Disposition", "attachment; filename=\"patv-voice-consent.json\"");
      res.json({ ok: true, terms_version: TERMS_VERSION, records: await record(req.user.userId) });
    } catch (e) { fail(res, e); }
  });

  // staff
  app.get("/api/voiceclone/admin", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!staff(req.user)) return res.status(403).json({ ok: false });
    try { res.json({ ok: true, rows: await adminRows(), cfg: CONFIG }); } catch (e) { fail(res, e); }
  });
  app.post("/api/voiceclone/admin", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!same(req, res)) return;
    if (!req.user || req.user.class !== "Admin") return res.status(403).json({ ok: false, error: "Admins only." });
    try {
      const b = req.body || {};
      if (b.config) await setConfig(b.config, req.user.username);
      let r = null;
      if (b.id && b.action) r = await decide(b.id, b.action, req.user.username, b.reason);
      res.json({ ok: true, result: r, rows: await adminRows(), cfg: CONFIG });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/voiceclone/audio/:id", addUser, async (req, res) => {
    if (!staff(req.user)) return res.status(403).end();
    try {
      const c = (await getQuery("SELECT audio FROM voice_consents WHERE id = ?", [Math.floor(Number(req.params.id) || 0)]))[0];
      if (!c || !c.audio) return res.status(404).end();
      res.set("Cache-Control", "private, no-store");
      res.type("audio/wav");
      res.sendFile(path.join(DIR, c.audio));
    } catch (e) { res.status(500).end(); }
  });
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => sweep().catch((e) => console.error("[voiceclone] sweep:", e.message)), 6 * 3600 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  init, config, setConfig, consent, recorded, created, createFailed, decide, revoke, botState, deleted, sweep, status, record, adminRows, register, start,
  score, coverage, words, accountOf, refusal, TERMS_VERSION, SCRIPTS, Refuse,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
