// telegramsso.js — "Sign in with Telegram" on /login and /register (1.99lb), with the official Telegram Login Widget.
//
// THE FLOW
//   /login + /register load https://telegram.org/js/telegram-widget.js (only while this method is on) and our button
//   calls Telegram.Login.auth({bot_id}) - Telegram's own popup (oauth.telegram.org) asks the member to confirm, and
//   hands the page the signed auth data {id, first_name, last_name, username, photo_url, auth_date, hash}.
//   POST /auth/telegram/callback  (same-site fetch, JSON) - the server checks it (verifyAuth):
//     * hash = HMAC-SHA256(data_check_string, SHA256(bot_token)), data_check_string = every received field except
//       hash, "key=value", sorted by key, joined with "\n" (core.telegram.org/widgets/login#checking-authorization)
//     * auth_date no older than MAX_AGE_S (1 hour) and not from the future
//     * single use: the hash is remembered (ssolinks.useOnce), so a captured sign-in can't be replayed
//   then the shared flow (ssolinks.js, identical to Sign in with Plex):
//     linked   (telegram_links - the SAME link the Telegram bridge makes with a /start code) -> finishLogin
//     not yet  -> /auth/sso/new: create a PATV account (username prefilled from Telegram) or "I already have an account"
//   Linking here writes the bridge's row (telegram.linkProven, proof 'login_widget'), so alerts and Pepe's commands work.
//
// The widget needs the bot's domain set in BotFather (/setdomain for @pepe_cf_bot -> publicaccess.tv); a bot has ONE
// domain, so staging needs its own bot (and its own TELEGRAM_BOT_TOKEN) or no Telegram button.
// Switch: ssoconf telegram_sso (default on) - effective only with TELEGRAM_BOT_TOKEN in .env.
"use strict";
const crypto = require("crypto");
const conf = require("./ssoconf");
const sso = require("./ssolinks");
const guard = require("./middleware/authGuard");

const MAX_AGE_S = 3600;
const FUTURE_S = 60;
const FIELDS = new Set(["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"]);
let clock = () => Date.now();

const callbackLimit = guard.limiter({ max: 30, windowMs: 15 * 60 * 1000 });

/**
 * Check Telegram Login Widget data. -> {ok: true, user: {tg_id, username, name}} | {ok: false, code}
 * code: E_BAD (missing / malformed), E_HASH (signature), E_STALE (too old), E_FUTURE.
 */
function verifyAuth(data, token, { now = clock(), maxAgeS = MAX_AGE_S } = {}) {
  if (!token) return { ok: false, code: "E_OFF" };
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, code: "E_BAD" };
  const hash = typeof data.hash === "string" ? data.hash.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, code: "E_BAD" };
  const pairs = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "hash") continue;
    if (!/^[a-z_]{1,32}$/.test(k) || v === null || v === undefined || typeof v === "object") return { ok: false, code: "E_BAD" };
    pairs.push(`${k}=${String(v)}`);
  }
  if (pairs.length > 16) return { ok: false, code: "E_BAD" };
  pairs.sort();
  const secret = crypto.createHash("sha256").update(token).digest();
  const want = crypto.createHmac("sha256", secret).update(pairs.join("\n")).digest();
  const got = Buffer.from(hash, "hex");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, code: "E_HASH" };
  const id = String(data.id == null ? "" : data.id);
  const when = Number(data.auth_date);
  if (!/^[1-9]\d{0,19}$/.test(id) || !Number.isInteger(when) || when <= 0) return { ok: false, code: "E_BAD" };
  const nowS = Math.floor(now / 1000);
  if (when > nowS + FUTURE_S) return { ok: false, code: "E_FUTURE" };
  if (nowS - when > maxAgeS) return { ok: false, code: "E_STALE" };
  const handle = typeof data.username === "string" && /^[A-Za-z0-9_]{3,40}$/.test(data.username) ? data.username : null;
  const name = [data.first_name, data.last_name].filter((x) => typeof x === "string" && x.trim()).join(" ").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 64);
  return { ok: true, user: { tg_id: id, handle, name, hash } };
}

const tr = (req, key, en, vars) => (req && typeof req.t === "function" ? req.t(key, vars) : en);

// the shared flow's Telegram provider
sso.provider("telegram", {
  label: "Telegram",
  icon: "✈️",
  readsEmail: false,
  async linkedUser(subject) {
    const T = require("./telegram");
    const l = await T.linkByTg(subject);
    if (!l || l.link_source !== "self") return null;
    const { getQuery } = require("./dbUtils");
    return (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [l.user_id]))[0] || null;
  },
  async linkTo(user, p) {
    await require("./telegram").linkProven(user.userId, { tg_id: p.subject, handle: p.handle });
  },
});

function enabled() { return conf.on.telegram(); }
/** What the auth pages need for the button (null = hidden). The bot id is the token's public prefix, never the token. */
function button() { return enabled() ? { botId: conf.telegramBotId() } : null; }

function register(app, { addUser }) {
  conf.init().catch(() => {});
  app.post("/auth/telegram/callback", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const done = (path, ok) => res.status(ok ? 200 : 400).json({ ok: !!ok, redirect: path });
    const fail = (key, en) => { req.flash("error", tr(req, key, en)); return done("/login", false); };
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Cross-site sign-in refused" });
    if (req.user && req.user.username) return done("/settings/account#connections", true);   // 1.99vz: Connections live on Settings -> Account
    await conf.init().catch(() => {});
    if (!enabled()) return fail("auth.sso.off", "That sign-in method isn't available right now.");
    const ip = guard.clientIp(req);
    if (callbackLimit.blocked(ip)) return fail("auth.sso.slow_down", "Too many sign-ins from your network. Try again in a few minutes.");
    callbackLimit.hit(ip);
    const body = req.body || {};
    const v = verifyAuth(body.auth, conf.telegramToken());
    if (!v.ok) {
      if (v.code !== "E_BAD") console.log(`[tgsso] refused (${v.code})`);
      return fail(v.code === "E_STALE" ? "auth.tg.stale" : "auth.tg.failed",
                  v.code === "E_STALE" ? "That Telegram sign-in is too old. Please try again." : "Telegram sign-in didn't work. Please try again.");
    }
    try {
      if (!(await sso.useOnce("tg:" + v.user.hash, (MAX_AGE_S + FUTURE_S) * 1000))) return fail("auth.sso.expired", "That sign-in expired or didn't start here. Please try again.");
      const next = guard.safeNext(body.next) || "";
      const path = await sso.signInOrPark(req, res, { provider: "telegram", subject: v.user.tg_id, handle: v.user.handle,
        username: v.user.handle || v.user.name, name: v.user.name, email: null, email_verified: false }, next);
      return done(path, true);
    } catch (e) {
      console.error("[tgsso] callback:", e && e.message);
      return fail("auth.tg.failed", "Telegram sign-in didn't work. Please try again.");
    }
  });
}

module.exports = { register, verifyAuth, enabled, button, MAX_AGE_S, _setClock: (fn) => { clock = fn || (() => Date.now()); } };
