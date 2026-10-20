// ssolinks.js — what every single-sign-on method shares (1.99lb): Telegram (telegramsso.js), Google (googlesso.js) and
// Apple (applesso.js) go through the SAME steps as Sign in with Plex (plexsso.js, 1.99jr), so the rules are identical:
//
//   1. the provider proves an identity (Telegram: the Login Widget's signed data; Google: an OpenID Connect ID token)
//   2. LINKED (an explicit, proven link to a PATV account) -> signed in through user.controller finishLogin, the one
//      way every sign-in finishes (password, Plex, Twitch...)
//   3. not linked -> the identity waits in THIS browser's session (10 minutes, single use) and /auth/sso/new offers
//        * "Create a PATV account" (POST /auth/sso/create: user.controller createSsoAccount - the sign-up rules: the
//          per-network new-account limit, username rules, Terms, the vesting welcome bonus with the provider identity)
//        * "I already have an account": /login shows a notice + a hidden link_sso=<provider>; the password sign-in
//          then links it (loginUser -> linkPendingTo)
//   A PATV account is NEVER picked by matching the provider's email or username (account takeover): only a link.
//
// Where the links live
//   telegram   telegram_links (telegram.js) - the SAME link the Telegram bridge uses (alerts, Pepe's commands);
//              link_source 'self', proof 'login_widget' (the bridge's own is proof 'start_code')
//   google     sso_links (here): provider 'google', subject = the ID token's `sub` (never the email), link_source
//              'self', proof 'oidc'. One Google account per PATV account and vice versa.
//   apple      sso_links too (applesso.js): provider 'apple', subject = Apple's `sub` (stable per developer team - v2's
//              identity service imports these rows by it), proof 'oidc'; refresh_token_enc = Apple's refresh token,
//              AES-256-GCM encrypted (unlinking revokes it at Apple); email_relay = 1 for a privaterelay.appleid.com
//              address (contact only); email_off = 1 while Apple says forwarding to it is off.
//   plex       plex_members (plexmembers.js), unchanged
//
// The last-method guard: an account must keep a way to sign in. users.password_set = 0 marks an account whose password
// is the random one an SSO sign-up gave it (set back to 1 when the member sets / resets a password; NULL = an older
// account, treated as having one). Unlinking Plex / Telegram / Google / Apple is refused when it's the last method left - the
// check and the unlink in one transaction (unlinkGuarded), so two unlinks at once can't both pass it.
//
//   sso_links   provider, subject, user_id, link_source, proof, email (display only), name, linked_at,
//               refresh_token_enc, token_at (when it was stored: Apple's notifications compare against it),
//               email_relay, email_off, email_event_at (the newest email event applied) (Apple),
//               rewarded (1 = this was the identity's FIRST link to any PATV account: only such a link counts for the
//               link achievement - one Apple / Google account can't earn it again on account after account)
//   sso_used    k PK, at          single-use keys (a Telegram widget hash) so a captured sign-in can't be replayed
//   sso_rewarded k PK (SHA-256 of provider:subject), provider, at   - identities whose link achievement was already earned
//               (kept when the link or the account goes, like welcome_bonus's identity keys - it's what stops the farming)
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");

const TTL = 10 * 60 * 1000;
let clock = () => Date.now();

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code || null; this.refuse = true; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS sso_links (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL,
        link_source TEXT NOT NULL DEFAULT 'self', proof TEXT NOT NULL, email TEXT, name TEXT, linked_at INTEGER NOT NULL,
        PRIMARY KEY (provider, subject))`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS sso_links_user ON sso_links (provider, user_id)");
      // Sign in with Apple (applesso.js): the encrypted refresh token (revoked at Apple on unlink) + the relay-address flags
      const have = (await getQuery("SELECT name FROM pragma_table_info('sso_links')")).map((c) => c.name);
      for (const [c, sql] of [["refresh_token_enc", "ALTER TABLE sso_links ADD COLUMN refresh_token_enc TEXT"],
                              ["token_at", "ALTER TABLE sso_links ADD COLUMN token_at INTEGER"],
                              ["email_relay", "ALTER TABLE sso_links ADD COLUMN email_relay INTEGER"],
                              ["email_off", "ALTER TABLE sso_links ADD COLUMN email_off INTEGER"],
                              ["email_event_at", "ALTER TABLE sso_links ADD COLUMN email_event_at INTEGER"],
                              ["rewarded", "ALTER TABLE sso_links ADD COLUMN rewarded INTEGER"]]) {
        if (have.includes(c)) continue;
        try { await runQuery(sql); }
        catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
      await runQuery("CREATE TABLE IF NOT EXISTS sso_used (k TEXT PRIMARY KEY, at INTEGER NOT NULL)");
      await runQuery("CREATE TABLE IF NOT EXISTS sso_rewarded (k TEXT PRIMARY KEY, provider TEXT NOT NULL, at INTEGER NOT NULL)");
      if (!have.includes("rewarded")) {
        // the links made before this column: each was its identity's first (one row per identity) - recorded, so a later link
        // of the same identity to another account doesn't earn the link achievement again
        for (const l of await getQuery("SELECT provider, subject FROM sso_links")) {
          await runQuery("INSERT OR IGNORE INTO sso_rewarded (k, provider, at) VALUES (?, ?, ?)", [rewardKey(l.provider, l.subject), l.provider, clock()]);
        }
        await runQuery("UPDATE sso_links SET rewarded = 1 WHERE rewarded IS NULL");
      }
      const cols = await getQuery("SELECT name FROM pragma_table_info('users')");
      if (cols.length && !cols.some((c) => c.name === "password_set")) {
        try { await runQuery("ALTER TABLE users ADD COLUMN password_set INTEGER"); }
        catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
        // accounts Sign in with Plex made (1.99jr) got a random password: mark them (a later password change sets 1)
        try { await runQuery("UPDATE users SET password_set = 0 WHERE password_set IS NULL AND userId IN (SELECT userId FROM welcome_bonus WHERE source = 'plex')"); }
        catch (e) { /* no welcome_bonus table */ }
      }
    })().catch((e) => { ready = null; console.error("[sso] init:", e.message); throw e; });
  }
  return ready;
}

// ── single use ──
/** true the FIRST time `key` is seen (kept `keepMs`), false after. */
async function useOnce(key, keepMs) {
  await init();
  const t = clock();
  if (Math.random() < 0.05) runQuery("DELETE FROM sso_used WHERE at < ?", [t - Math.max(keepMs || 0, 2 * 86400e3)]).catch(() => {});
  const r = await runQuery("INSERT OR IGNORE INTO sso_used (k, at) VALUES (?, ?)", [String(key).slice(0, 200), t]);
  return !!(r && r.changes);
}

// ── sso_links (Google) ──
const achievementsMod = () => require("./achievements");
async function linkOf(provider, userId) { await init(); return (await getQuery("SELECT * FROM sso_links WHERE provider = ? AND user_id = ?", [provider, String(userId || "")]))[0] || null; }
async function linkBySubject(provider, subject) { await init(); return (await getQuery("SELECT * FROM sso_links WHERE provider = ? AND subject = ?", [provider, String(subject || "")]))[0] || null; }
async function account(userId) {
  return (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [String(userId || "")]))[0] || null;
}
/** The account explicitly linked to (provider, subject), or null. */
async function linkedUser(provider, subject) {
  const l = await linkBySubject(provider, subject);
  return l && l.link_source === "self" ? account(l.user_id) : null;
}
// the link achievements' quiet backfills (achievements.js), per provider: 🍀 I'm Feeling Lucky (Google), 🍏 Core Member (Apple)
const LINK_BACKFILL = { google: "googleBackfill", apple: "appleBackfill" };
/** The sso_rewarded key of an identity (a hash: the table outlives the link and the account). */
function rewardKey(provider, subject) { return crypto.createHash("sha256").update("sso-reward:" + provider + ":" + String(subject)).digest("hex"); }
/**
 * Link (provider, subject) to userId. Refuses a subject linked elsewhere and a second one of the same provider.
 * email / name are display only (a re-link keeps the old ones when the provider sends none - Apple sends them once);
 * secret = an encrypted provider token (Apple's refresh token, applesso.js; token_at = when it was stored), relay = the email
 * is a private relay address.
 */
async function addLink(provider, userId, { subject, proof, email, name, secret, relay } = {}) {
  await init();
  const other = await linkBySubject(provider, subject);
  if (other && other.user_id !== userId) throw new Refuse(409, "That account is already linked to another PATV account - unlink it there first.", "E_TAKEN");
  const mine = await linkOf(provider, userId);
  if (mine && mine.subject !== String(subject)) throw new Refuse(409, "This PATV account already has one linked - unlink it first.", "E_HAS_OTHER");
  const t = clock();
  if (mine) {
    await runQuery(`UPDATE sso_links SET email = COALESCE(?, email), name = COALESCE(?, name), refresh_token_enc = COALESCE(?, refresh_token_enc),
                    token_at = CASE WHEN ? IS NULL THEN token_at ELSE ? END, email_relay = CASE WHEN ? IS NULL THEN email_relay ELSE ? END
                    WHERE provider = ? AND subject = ?`,
                   [email || null, name || null, secret || null, secret || null, t, email || null, relay ? 1 : 0, provider, String(subject)]);
    return { already: true };
  }
  // 1.99lu: accounts linked before 🍀 I'm Feeling Lucky existed get it quietly first, so only this link is announced (Apple: the same)
  if (LINK_BACKFILL[provider]) await achievementsMod()[LINK_BACKFILL[provider]]().catch((e) => console.error("[sso] achievement backfill:", e.message));
  // the identity's first link to PATV ever? Only that one counts for the link achievement (an Apple / Google account moved from
  // account to account - unlink, link elsewhere; or sign up, set a password, unlink, sign up again - earns it once, not each time)
  // (one transaction: a link that fails to insert - another tab won the race - doesn't use up the identity's achievement)
  await tx(async () => {
    const first = await runQuery("INSERT OR IGNORE INTO sso_rewarded (k, provider, at) VALUES (?, ?, ?)", [rewardKey(provider, subject), provider, t]);
    await runQuery(`INSERT INTO sso_links (provider, subject, user_id, link_source, proof, email, name, linked_at, refresh_token_enc, token_at, email_relay, rewarded)
                    VALUES (?, ?, ?, 'self', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [provider, String(subject), userId, proof, email || null, name || null, t, secret || null, secret ? t : null, relay ? 1 : null, first && first.changes ? 1 : 0]);
  });
  // 1.99lu: 🍀 I'm Feeling Lucky / 🍏 Core Member (+ its cosmetic) - XP, PAT from the achievements flow, announced by Pepe; once
  // per account AND once per identity (sso_links.rewarded). Every Google / Apple link comes through here: Settings -> Account ->
  // Connections, "I already have an account", a new SSO account.
  if (LINK_BACKFILL[provider]) await achievementsMod().checkWeb(userId).catch(() => {});
  return { already: false };
}
async function removeLink(provider, userId) {
  await init();
  const r = await runQuery("DELETE FROM sso_links WHERE provider = ? AND user_id = ?", [provider, String(userId || "")]);
  return !!(r && r.changes);
}

// ── the last-method guard ──
async function passwordSet(userId) {
  await init();
  const r = (await getQuery("SELECT password_set FROM users WHERE userId = ?", [String(userId || "")]))[0];
  return !r || r.password_set === null || r.password_set === undefined || Number(r.password_set) !== 0;
}
async function markPassword(userId, isSet) {
  try { await init(); await runQuery("UPDATE users SET password_set = ? WHERE userId = ?", [isSet ? 1 : 0, String(userId || "")]); }
  catch (e) { console.error("[sso] password_set:", e.message); }
}
/** The ways this account can sign in: password, twitch, discord, plex, telegram, google, apple. */
async function methods(userId) {
  await init();
  const conf = require("./ssoconf");
  const out = [];
  if (await passwordSet(userId)) out.push("password");
  const u = (await getQuery("SELECT twitchId, discordId FROM users WHERE userId = ?", [String(userId || "")]).catch(() => []))[0] || {};
  if (u.twitchId) out.push("twitch");
  if (u.discordId) out.push("discord");
  try {
    const TRUSTED = require("./plexsso").TRUSTED;
    const rows = await getQuery("SELECT link_source FROM plex_members WHERE user_id = ?", [String(userId || "")]);
    if (rows.some((r) => TRUSTED.includes(r.link_source))) out.push("plex");
  } catch (e) { /* no plex_members table */ }
  if (conf.telegramConfigured()) {
    try { if (await require("./telegram").linkOf(userId)) out.push("telegram"); } catch (e) { /* no table */ }
  }
  if (conf.googleConfigured() && (await linkOf("google", userId))) out.push("google");
  if (conf.appleConfigured() && (await linkOf("apple", userId))) out.push("apple");
  return out;
}
/** Throws E_LAST_METHOD when unlinking `method` would leave the account with no way to sign in. */
async function guardUnlink(userId, method) {
  const m = await methods(userId);
  if (m.some((x) => x !== method)) return true;
  if (!m.includes(method)) return true;           // not a sign-in method here (e.g. Telegram without the widget set up)
  throw new Refuse(409, "That's the only way you can sign in. Set a password first (Edit profile, Password), then unlink it.", "E_LAST_METHOD");
}
/**
 * Unlink `method` under the last-method guard: the guard's check and remove() (which does the unlinking, inside the
 * transaction) run in ONE dbUtils.tx. Transactions run one at a time, so two unlinks at once (Apple + Google from two tabs, or
 * Telegram's /unlink + Plex) can't both pass the guard on the same "two methods left" and leave the account with no way in:
 * the second one checks after the first one's delete. -> remove()'s result. Throws E_LAST_METHOD (nothing removed).
 * Every guarded unlink goes through here (Google, Apple, Telegram, Plex); Apple's consent-revoked notification makes the same
 * check inside its own transaction (applesso.onNotification).
 */
async function unlinkGuarded(userId, method, remove) {
  await init();
  return tx(async () => {
    await guardUnlink(userId, method);
    return remove();
  });
}

// ── the shared sign-in flow ──
// providers register: { label, icon, linkedUser(subject) -> account|null, linkTo(user, pending) -> void (throws Refuse) }
const PROVIDERS = {};
function provider(name, impl) { PROVIDERS[name] = impl; }

const tr = (req, key, en, vars) => (req && typeof req.t === "function" ? req.t(key, vars) : String(en).replace(/\{!?(\w+)\}/g, (m, n) => (vars && vars[n] != null ? String(vars[n]) : m)));
function fresh(o) { return !!o && typeof o === "object" && Number(o.at) > 0 && clock() - Number(o.at) <= TTL; }

/** The identity waiting in this session (or null): {provider, subject, username, handle, email, email_verified, name, at, next}. */
function pendingFor(req) {
  const p = req && req.session && req.session.ssoPending;
  if (!fresh(p) || !PROVIDERS[p.provider]) { if (req && req.session && p) delete req.session.ssoPending; return null; }
  return p;
}
function setPending(req, p) {
  if (req.session) delete req.session.plexPending;       // one pending identity at a time
  req.session.ssoPending = { ...p, at: clock() };
}
const home = (u, next) => next || `/u/${encodeURIComponent(u.username)}/wheel`;

/**
 * After a provider proved `who` ({provider, subject, username, handle, email, email_verified, name}): sign the linked
 * account in, or park the identity for /auth/sso/new. -> the path to send the browser to.
 */
async function signInOrPark(req, res, who, next) {
  const P = PROVIDERS[who.provider];
  const u = await P.linkedUser(who.subject);
  if (u) {
    await require("./user.controller").finishLogin(req, res, u, `${who.provider} sign-in`);
    console.log(`[sso] ${u.username} signed in with ${who.provider}`);
    return home(u, next);
  }
  setPending(req, { ...who, next: next || "" });
  return "/auth/sso/new";
}

/** "I already have an account": link the session's pending identity to `user` after a password sign-in. */
async function linkPendingTo(req, user, providerName) {
  const p = pendingFor(req);
  if (!p || !user || !user.userId || (providerName && p.provider !== providerName)) return null;
  delete req.session.ssoPending;
  const P = PROVIDERS[p.provider];
  try {
    await P.linkTo(user, p);
    req.flash("success", tr(req, "auth.sso.linked", `Your ${P.label} account is linked. Next time, just sign in with ${P.label}.`, { provider: P.label }));
    return true;
  } catch (e) {
    req.flash("error", e && e.refuse ? e.message : tr(req, "auth.sso.link_failed", "That account couldn't be linked. Try again from Edit profile, Connections."));
    return null;
  }
}

/** A security notice in the member's inbox for every new sign-in link ("not you? unlink it"). Never throws. */
async function notifyLinked(user, providerLabel, what) {
  const userId = user && user.userId;
  try {
    const I = require("./i18n");
    const t = I.tFor(I.getPref(userId) || "en");
    await require("./inbox").addSafe(userId, { kind: "system", title: t("auth.sso.notice_title", { provider: providerLabel }),
      body: t("auth.sso.notice_body", { provider: providerLabel, what: what || "" }), link: "/settings/account#connections", ref: `ssolink:${providerLabel}:${clock()}` });
  } catch (e) { /* logged there */ }
}

function register(app, { addUser, authView }) {
  // 1.99lu: the one-off quiet 🍀 I'm Feeling Lucky backfill for accounts already linked to Google (a no-op once done); the
  // 🍏 Core Member one for Apple the same way
  // (each on its own: one failing never skips the other)
  const ready = init();
  for (const fn of ["googleBackfill", "appleBackfill"]) ready.then(() => achievementsMod()[fn]()).catch((e) => console.error(`[sso] setup (${fn}):`, e.message));
  const guard = require("./middleware/authGuard");
  const UC = () => require("./user.controller");
  const createLimit = guard.limiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const view = (req, extra) => (authView ? authView(req, extra) : Object.assign({ user: req.user ? req.user.username : null, errors: req.flash("error"),
    success: req.flash("success"), form: {}, next: "" }, extra));
  const fail = (req, res, key, en) => { req.flash("error", tr(req, key, en)); return res.redirect("/login"); };
  const expired = (req, res) => fail(req, res, "auth.sso.expired", "That sign-in expired or didn't start here. Please try again.");
  const conf = require("./ssoconf");
  const enabled = (p) => (conf.on[p.provider] ? conf.on[p.provider]() : false);

  app.get("/auth/sso/new", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.user && req.user.username) return res.redirect("/settings/account#connections");   // 1.99vz
    const p = pendingFor(req);
    if (!p) return expired(req, res);
    let suggest = "";
    try { suggest = await UC().generateUniqueUsername(p.username || p.name || ""); } catch (e) { suggest = ""; }
    const P = PROVIDERS[p.provider];
    res.render("ssoNew", view(req, { sso: { provider: p.provider, label: P.label, icon: P.icon, who: p.handle ? "@" + p.handle : (p.name || p.username || P.label),
      email: !!p.email, verified: !!p.email_verified, readsEmail: !!P.readsEmail, relay: !!p.relay, note: P.note || null }, suggest, next: p.next || "" }));
  });

  app.post("/auth/sso/create", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req)) return res.status(403).send("Cross-site sign-up refused");
    if (req.user && req.user.username) return res.redirect("/settings/account#connections");   // 1.99vz
    const p = pendingFor(req);
    if (!p) return expired(req, res);
    if (!enabled(p)) return fail(req, res, "auth.sso.off", "That sign-in method isn't available right now.");
    const P = PROVIDERS[p.provider];
    const username = String((req.body || {}).username || "").trim().slice(0, 64);
    const back = (msg, field) => { req.flash("error", msg); req.flash("authForm", JSON.stringify({ username, field })); return res.redirect("/auth/sso/new"); };
    const ip = guard.clientIp(req);
    if (createLimit.blocked(ip)) return back(tr(req, "auth.sso.slow_down", "Too many sign-ins from your network. Try again in a few minutes."));
    createLimit.hit(ip);
    try {
      // linked meanwhile (another tab): never a second account for one identity
      const already = await P.linkedUser(p.subject);
      if (already) { delete req.session.ssoPending; await UC().finishLogin(req, res, already, `${p.provider} sign-in`); return res.redirect(home(already, p.next)); }
      const r = await UC().createSsoAccount(req, res, { username, email: p.email, emailVerified: !!p.email_verified, provider: p.provider,
                                                        identity: `${p.provider}:${p.subject}` });
      if (r.error) return back(r.error, r.field);
      delete req.session.ssoPending;
      try { await P.linkTo(r.user, p, { created: true }); }
      catch (e) { console.error(`[sso] link new account (${p.provider}):`, e && e.message); }
      await UC().finishLogin(req, res, r.user, `${p.provider} sign-up`);
      req.flash("success", tr(req, "auth.sso.welcome", `Welcome to PATV, ${r.user.username}! Your ${P.label} account is linked.`, { name: r.user.username, provider: P.label }));
      return res.redirect(home(r.user, p.next));
    } catch (e) {
      console.error("[sso] create:", e && e.message);
      return back(tr(req, "auth.err.register_failed", "Something went wrong creating your account. Please try again."));
    }
  });

  app.post("/auth/sso/cancel", addUser, (req, res) => {
    if (!guard.sameSite(req)) return res.status(403).send("Cross-site request refused");
    if (req.session) delete req.session.ssoPending;
    res.redirect("/login");
  });
}

module.exports = {
  init, register, provider, PROVIDERS, pendingFor, setPending, signInOrPark, linkPendingTo, notifyLinked, useOnce,
  linkOf, linkBySubject, linkedUser, addLink, removeLink, passwordSet, markPassword, methods, guardUnlink, unlinkGuarded, rewardKey, Refuse, TTL,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
