// chatticket.js — v1 chat tickets for the chat hub (S0, 1.99acf; the chat design §2.2, docs/chat-tickets.md).
//
// A signed-in page asks for a short-lived ticket and hands it to the chat hub in its first frame (never in a URL):
//   POST /api/chat/ticket                  same-origin fetch with X-Requested-With: fetch, a live sign-in session
//     -> {ok, token, exp, kid}             a 5-minute EdDSA (Ed25519) JWT, Cache-Control: no-store
//   GET  /.well-known/patv-jwks.json       the public keys (current + previous kid), public, cached 5 minutes
// Claims (exactly §2.2's list - display hints only, nothing in a ticket grants power):
//   iss "patv-v1", aud "patv-rt", sub = users.userId (a UUID; a legacy non-UUID id -> uuidv5(id, CHAT_GENESIS_NS), or refused
//   E_LEGACY_ID while that namespace isn't set), sid = sessions.id[:32] (sessions.id is already sha256 of the cookie's sid),
//   iat, exp = iat + 300, cls = users.class lower-cased, ver = verified.verify(), lvl = users.level, nsfw false (v1 has no
//   server-side opt-in), scp ["chat"], pp "web", kid.
//
// Keys come from the environment (never the database, never logged; tools/chat-ticket-key.js makes them):
//   CHAT_TICKET_KEY        base64 of the PKCS8 DER Ed25519 private key - signs
//   CHAT_TICKET_KID        its kid (^[A-Za-z0-9._:~-]{1,64}$), e.g. v1-2026-10 (staging v1stg-2026-10)
//   CHAT_TICKET_PREV_PUB   the previous key (base64 SPKI DER, or its PKCS8 private key - only the public half is used) and
//   CHAT_TICKET_PREV_KID   its kid: published in the JWKS through a rotation, never used to sign
//   CHAT_GENESIS_NS        optional: the UUID namespace for legacy ids
// No key (or an unusable one: one log line naming the variable) = tickets off; the JWKS is served whenever a key is loaded,
// even with the switch off, so the hub can fetch it first. The switch: hubseam.tickets (/admin/keys#seam, default off), which
// only mints together with hubseam.sessions and hubseam.heartbeat (mintable()).
"use strict";
const crypto = require("crypto");
const { getQuery } = require("./dbUtils");

const ISS = "patv-v1", AUD = "patv-rt", TTL_S = 300;
const KID_RE = /^[A-Za-z0-9._:~-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PER_SESSION = { max: 20, windowMs: 60 * 1000 };
const PER_ACCOUNT = { max: 200, windowMs: 60 * 60 * 1000 };

let clock = () => Date.now();
const now = () => clock();
const b64u = (b) => Buffer.from(b).toString("base64url");

// ── keys ──
let KEYS = null;
function loadKeys() {
  const out = { cur: null, prev: null, error: null };
  const raw = String(process.env.CHAT_TICKET_KEY || "").trim();
  const kid = String(process.env.CHAT_TICKET_KID || "").trim();
  if (!raw && !kid) { out.error = "unset"; return out; }
  try {
    if (!KID_RE.test(kid)) throw new Error("kid");
    const priv = crypto.createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
    if (priv.asymmetricKeyType !== "ed25519") throw new Error("type");
    out.cur = { kid, priv, pub: crypto.createPublicKey(priv) };
  } catch (e) {
    console.error(`[chatticket] CHAT_TICKET_KEY / CHAT_TICKET_KID ${e.message === "kid" ? "(the kid)" : "(the key)"} can't be used - chat tickets are off`);
    out.error = "bad_key";
    return out;
  }
  const prevRaw = String(process.env.CHAT_TICKET_PREV_PUB || "").trim();
  const prevKid = String(process.env.CHAT_TICKET_PREV_KID || "").trim();
  if (prevRaw || prevKid) {
    try {
      if (!KID_RE.test(prevKid) || prevKid === kid) throw new Error("kid");
      const der = Buffer.from(prevRaw, "base64");
      let pub;
      try { pub = crypto.createPublicKey({ key: der, format: "der", type: "spki" }); }
      catch (e) { pub = crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" })); }
      if (pub.asymmetricKeyType !== "ed25519") throw new Error("type");
      out.prev = { kid: prevKid, pub };
    } catch (e) {
      console.error(`[chatticket] CHAT_TICKET_PREV_PUB / CHAT_TICKET_PREV_KID ${e.message === "kid" ? "(the kid)" : "(the key)"} can't be used - the JWKS lists the current key only`);
    }
  }
  return out;
}
function keys() { if (!KEYS) KEYS = loadKeys(); return KEYS; }
/** [current kid, previous kid] (only those loaded) - the heartbeat carries them. */
function kids() { const K = keys(); return [K.cur && K.cur.kid, K.prev && K.prev.kid].filter(Boolean); }

function jwk(pub, kid) {
  const j = pub.export({ format: "jwk" });
  return { kty: "OKP", crv: "Ed25519", x: j.x, kid, alg: "EdDSA", use: "sig" };
}
/** The JWKS, or null when no key is loaded. */
function jwks() {
  const K = keys();
  if (!K.cur) return null;
  return { keys: [jwk(K.cur.pub, K.cur.kid), ...(K.prev ? [jwk(K.prev.pub, K.prev.kid)] : [])] };
}

/** Compact JWS (EdDSA). */
function signJwt(payload, k) {
  const input = b64u(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: k.kid })) + "." + b64u(JSON.stringify(payload));
  return input + "." + b64u(crypto.sign(null, Buffer.from(input), k.priv));
}

/** account_id for the hub: the userId when it is a UUID; else uuidv5(userId, CHAT_GENESIS_NS) when set; else null. */
function subjectOf(userId) {
  const id = String(userId || "");
  if (UUID_RE.test(id)) return id.toLowerCase();
  const ns = String(process.env.CHAT_GENESIS_NS || "").trim();
  if (!UUID_RE.test(ns)) return null;
  return require("uuid").v5(id, ns);
}

/** The claims for an account row + its session id (exactly §2.2's set). */
async function claimsFor(u, sessionId, kid, t = now()) {
  const iat = Math.floor(t / 1000);
  let ver = false;
  try { ver = !!(await require("./verified").verify(u)); } catch (e) { ver = false; }
  return { iss: ISS, aud: AUD, sub: subjectOf(u.userId), sid: String(sessionId).slice(0, 32), iat, exp: iat + TTL_S,
           cls: String(u.class || "pleb").toLowerCase(), ver, lvl: Number(u.level) || 0, nsfw: false, scp: ["chat"], pp: "web", kid };
}

/** 1.99acf: tickets only while the hub also hears every revocation and the heartbeat (hubseam.tickets AND sessions AND
 *  heartbeat): otherwise a sign-out / ban / password reset never reaches the hub and its 12-hour resume credential (bound to
 *  the ticket's sid) and open sockets would outlive the v1 session. huboutbox.setSettings refuses the other combinations. */
function mintable() {
  try { const ho = require("./huboutbox"); return ho.on("tickets") && ho.on("sessions") && ho.on("heartbeat"); } catch (e) { return false; }
}

// ── counters for /admin/keys#seam (one process) ──
let minted = { day: null, n: 0 };
function countMint(t) { const d = new Date(t).toISOString().slice(0, 10); if (minted.day !== d) minted = { day: d, n: 0 }; minted.n++; }
function status() {
  const K = keys();
  const on = mintable();
  const d = new Date(now()).toISOString().slice(0, 10);
  return { on, key: !!K.cur, error: K.cur ? null : K.error, kid: K.cur ? K.cur.kid : null, prev_kid: K.prev ? K.prev.kid : null,
           genesis_ns: UUID_RE.test(String(process.env.CHAT_GENESIS_NS || "").trim()), minted_today: minted.day === d ? minted.n : 0 };
}

const sameOriginStrict = (req) => {              // the sessions.js rule: Origin (or Referer) must be this host
  const src = req.get("origin") || req.get("referer");
  try { return !!src && new URL(src).host === req.get("host"); } catch (e) { return false; }
};
let hasArchived = null;
async function archivedColumn() {
  if (hasArchived === null) {
    try { hasArchived = (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at"); } catch (e) { hasArchived = false; }
  }
  return hasArchived;
}

function register(app, { addUser }) {
  const guard = require("./middleware/authGuard");
  const perSession = guard.limiter(PER_SESSION), perAccount = guard.limiter(PER_ACCOUNT);
  const fail = (res, status, code) => res.status(status).json({ ok: false, code });

  app.post("/api/chat/ticket", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const K = keys();
      if (!K.cur || !mintable()) return fail(res, 503, "E_FEATURE_OFF");
      if (req.get("X-Requested-With") !== "fetch" || !sameOriginStrict(req)) return fail(res, 403, "E_CSRF");
      const sess = req.loginSession;
      if (!sess || !sess.id || !req.user || !req.user.userId || String(req.user.userId) !== String(sess.userId)) return fail(res, 401, "E_AUTH");
      const u = (await getQuery(`SELECT userId, class, level, camfrogUsername, discordId, twitchId, email, isEmailVerified
                                 ${(await archivedColumn()) ? ", archived_at" : ""} FROM users WHERE userId = ?`, [String(sess.userId)]))[0];
      if (!u) return fail(res, 401, "E_AUTH");
      if (u.archived_at) return fail(res, 403, "E_ARCHIVED");
      const wait = Math.max(perSession.blocked("s:" + sess.id), perAccount.blocked("a:" + u.userId));
      if (wait) { res.set("Retry-After", String(wait)); return fail(res, 429, "E_RATE"); }
      perSession.hit("s:" + sess.id);
      perAccount.hit("a:" + u.userId);
      const t = now();
      const claims = await claimsFor(u, sess.id, K.cur.kid, t);
      if (!claims.sub) return fail(res, 409, "E_LEGACY_ID");
      const token = signJwt(claims, K.cur);
      countMint(t);
      res.json({ ok: true, token, exp: claims.exp, kid: K.cur.kid });
    } catch (e) {
      console.error("[chatticket] mint:", e.message);
      fail(res, 500, "E_INTERNAL");
    }
  });

  app.get("/.well-known/patv-jwks.json", (req, res) => {
    const j = jwks();
    if (!j) { res.set("Cache-Control", "no-store"); return res.status(404).json({ ok: false, code: "E_NOT_FOUND" }); }
    res.set("Cache-Control", "public, max-age=300");
    res.json(j);
  });
}

module.exports = { register, keys, kids, jwks, status, claimsFor, signJwt, subjectOf, mintable, ISS, AUD, TTL_S, KID_RE,
                   _reload: () => { KEYS = null; return keys(); }, _setClock: (f) => { clock = f || (() => Date.now()); },
                   _resetCounts: () => { minted = { day: null, n: 0 }; hasArchived = null; } };
