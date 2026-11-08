// user.controller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { issueLogin, clearLogin } = require('./middleware/loginCookie');
const guard = require('./middleware/authGuard');
const sqlite3 = require('sqlite3').verbose()
const { v4: uuidv4 } = require('uuid');
const mailer = require('./mailer');   // 1.99aim: account emails (Resend first, then SendGrid)
const crypto = require('crypto');
const { createTables, runQuery, getQuery } = require('./dbUtils');
const funding = require('./funding');
const ledger = require('./ledger');   // 1.99ga
const { moveUserRows, copyCamfrogBadges, archiveMerged, logMerge, afterMerge } = require('./accountMerge');
const inbox = require('./inbox');
const displaynames = require('./displaynames');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const AWS = require('aws-sdk');
const upload = multer({ dest: 'uploads/' });
// 1.99vz: the account forms (username, email, password, Camfrog / Twitch / Discord links) live on Settings -> Account
const ACCOUNT_PAGE = '/settings/account';

// AWS S3 configuration
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// Connect to SQLite database
const db = new sqlite3.Database('./myapp.db', (err) => {
  if (err) {
      console.error('Error opening database ' + err.message);
  } else {
      console.log('Database connected.');
  }
});
require('./sqlitecfg').tune(db, { label: 'user.controller' });   // 1.99fb: busy_timeout + WAL (sqlitecfg.js)

// ---------------------------------------------------------------------------------------------
// Sign-up and sign-in (views/register.ejs, views/login.ejs)
// ---------------------------------------------------------------------------------------------
// Failed sign-ins, three ways: one IP guessing one account, anyone guessing one account, one IP
// guessing many accounts. A good sign-in clears the IP+account counter.
const loginPairLimit = guard.limiter({ max: 8, windowMs: 15 * 60 * 1000 });
const loginNameLimit = guard.limiter({ max: 25, windowMs: 15 * 60 * 1000 });
const loginIpLimit = guard.limiter({ max: 40, windowMs: 15 * 60 * 1000 });
// New accounts per IP
const registerLimit = guard.limiter({ max: 5, windowMs: 60 * 60 * 1000 });

// A real bcrypt hash to compare against when the account doesn't exist, so a wrong username takes
// as long as a wrong password (no timing hint about which accounts exist).
let dummyHashP = null;
function dummyHash() {
  if (!dummyHashP) dummyHashP = bcrypt.hash(crypto.randomBytes(16).toString("hex"), 12);
  return dummyHashP;
}

// Send the visitor back to a form with a message, what they typed (never the password) and the
// field to point at.
function backTo(req, res, page, next, msg, form) {
  req.flash("error", msg);
  req.flash("authForm", JSON.stringify(form || {}));
  return res.redirect(page + (next ? "?next=" + encodeURIComponent(next) : ""));
}

// Function to handle user registration
async function registerUser(req, res) {
  const body = req.body || {};
  const username = String(body.username == null ? "" : body.username).trim();
  const email = String(body.email == null ? "" : body.email).trim();
  const password = typeof body.password === "string" ? body.password : "";
  const confirm = body.confirm_password;
  const next = guard.safeNext(body.next);
  const back = (msg, field) => backTo(req, res, "/register", next, msg, { username: username.slice(0, 64), email: email.slice(0, 254), field });

  if (!guard.authFormOk(req)) return res.status(403).send(guard.FORM_REFUSED);   // 1.99zl
  const ip = guard.clientIp(req);
  const wait = registerLimit.blocked(ip);
  if (wait) return back(req.t ? req.t('auth.err.too_many_accounts', { wait: guard.waitText(wait, req) }) : `Too many new accounts from your network. Try again in ${guard.waitText(wait)}.`);
  // 1.99ajn padppl (review fix): a network ban (netban.js) refuses a new account here, on the form with its message (it was a bare 403 page)
  try { const NB = require("./netban"); if (NB.isOn()) { const why = await NB.refusal(req, {}); if (why) return back(why); } } catch (e) { /* fail open */ }

  let problem;
  if ((problem = guard.checkUsername(username, req))) return back(problem, "username");
  // (1.99ajw padppl rework, owner: a name Pepe has seen on Camfrog is never refused - a gentle hint after the account exists, cfnames.nameHint)
  if ((problem = guard.checkEmail(email, req))) return back(problem, "email");
  if ((problem = guard.checkPassword(password, username, req))) return back(problem, "password");
  if (typeof confirm === "string" && confirm !== password) return back(req.t ? req.t('auth.err.mismatch') : "Those passwords don't match.", "confirm_password");

  const userId = uuidv4();
  try {
    const taken = await getQuery(
      "SELECT LOWER(username) = LOWER(?) AS u, LOWER(email) = LOWER(?) AS e FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 5",
      [username, email, username, email]
    );
    if (taken.some((r) => r.u)) return back(req.t ? req.t('auth.err.username_taken') : "That username is taken. Try another one.", "username");
    if (taken.some((r) => r.e)) return back(req.t ? req.t('auth.err.email_taken') : "That email already has an account. Sign in, or reset your password if you've forgotten it.", "email");

    const hashedPassword = await bcrypt.hash(password, 12);
    try {
      await runQuery(
        "INSERT INTO users (userId, username, displayname, password, email, points_balance, xp, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        // 1.99bg: starts at 0 (the 50,000 here was minted and farmable) - the welcome bonus vests (welcome.js)
        [userId, username, username, hashedPassword, email, 0, 0, "/public/img/avatar.png"]
      );
    } catch (e) {
      // two sign-ups for the same name at once: the UNIQUE index catches the second
      if (/UNIQUE/i.test(String(e && e.message))) return back(req.t ? req.t('auth.err.just_taken') : "That username or email was just taken. Try another one.", "username");
      throw e;
    }
    registerLimit.hit(ip);
    try { require("./netban").note(userId, req, "signup").catch(() => {}); } catch (e) { /* 1.99ajn padppl: netban.js */ }
    console.log(`[auth] new account ${username} (${userId})`);
    // 1.99cc: the form says "By creating an account you agree to the Terms" - record which version, and when
    // 1.99cf: only while the Terms are enforced (the form shows that line only then); otherwise they're asked on their first post
    const termsMod = require("./terms");
    if (termsMod.enforced()) await termsMod.accept(userId).catch((e) => console.error("[auth] terms accept:", e.message));
    await displaynames.markNewAccount(userId).catch(() => {});   // displayname = username, automatic
    await require("./welcome").enroll(userId, "web", req, res);

    // Best effort: the account exists whether or not these work.
    try {
      const token = generateValidationToken();
      await updateUserWithToken(userId, token);
      sendVerificationEmail(email, username, token);
    } catch (e) {
      console.error("[auth] verification setup failed:", e.message);
    }
    try {
      await awardBadge(userId, "fresh_meat");
    } catch (e) {
      console.error("[auth] fresh_meat badge:", e.message);
    }

    // Signed straight in (same 90-day login as a normal sign-in; 1.99wj: a server-side session, sessions.js)
    await require("./sessions").signIn(req, res, { userId, username, class: "pleb" }, next && next.startsWith("/claim/") ? "claim" : "password", { signup: true });
    req.flash("success", req.t ? req.t('auth.welcome', { name: username }) : `Welcome to PATV, ${username}! Check your email to verify your address.`);
    await require("./cfnames").hintAfter(req, userId, username);   // 1.99ajw padppl rework: "Is <name> your Camfrog name? Link it in Settings…"
    return res.redirect(next || `/u/${encodeURIComponent(username)}/wheel`);
  } catch (error) {
    console.error(`[auth] registration error: ${error && error.message}`);
    return back(req.t ? req.t('auth.err.register_failed') : "Something went wrong creating your account. Please try again.");
  }
}

// Function to generate a unique validation link
function generateValidationToken() {
  return crypto.randomBytes(20).toString('hex');
}

// 1.99gb: a username from a Twitch / Discord name, by the register form's rules (authGuard.checkUsername:
// [A-Za-z0-9._-], 3-48 characters, no dot / dash / underscore at either end, no reserved "CF" prefix).
// Accents are dropped ("José" -> "Jose"), spaces become "_", anything else outside the set goes, a leading
// "cf" / "CF" is stripped (Pepe's automatic Camfrog accounts are "CF..."). null when nothing usable is left.
// 1.99ui: the limit is usernamerules.USERNAME_MAX (48), was 24.
const { USERNAME_MAX } = require('./usernamerules');
function normaliseUsername(raw) {
  let s = String(raw == null ? "" : raw).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9._-]/g, "");
  const trim = (x) => x.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  s = trim(s);
  while (/^cf/i.test(s)) s = trim(s.slice(2));
  s = trim(s.slice(0, USERNAME_MAX));
  return s.length >= 3 && !guard.checkUsername(s) ? s : null;
}

// A free username for an account made from a Twitch / Discord sign-in: the normalised name, then name1,
// name2... (cut to fit USERNAME_MAX characters), else user#### - free in ANY letter case (the register form and
// /api/users/username check case-insensitively too).
async function generateUniqueUsername(baseUsername) {
  // (1.99ajw padppl rework: a Camfrog login Pepe has seen is a name like any other - someone signing in with Twitch / Discord as their own
  // Camfrog name gets it; only another PATV account's username counts as taken)
  const taken = async (u) => (await getQuery("SELECT 1 FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1", [u])).length > 0;
  const base = normaliseUsername(baseUsername);
  if (base) {
    if (!(await taken(base))) return base;
    for (let n = 1; n < 1000; n++) {
      const suffix = String(n);
      const u = base.slice(0, USERNAME_MAX - suffix.length).replace(/[._-]+$/, "") + suffix;
      if (u.length >= 3 && !guard.checkUsername(u) && !(await taken(u))) return u;
    }
  }
  for (let i = 0; i < 200; i++) {
    const u = "user" + String(Math.floor(Math.random() * (i < 100 ? 10000 : 100000000))).padStart(4, "0");
    if (!(await taken(u))) return u;
  }
  return "user" + crypto.randomBytes(6).toString("hex");
}

// Funtion to add email validation token to a user
async function updateUserWithToken(userId, token) {
  const expires = new Date();
  expires.setHours(expires.getHours() + 24); // Set token to expire in 24 hours
  const sql = `UPDATE users SET emailVerificationToken = ?, tokenExpires = ? WHERE userId = ?`;
  await runQuery(sql, [token, expires, userId]);
}

// Function to handle email validation
async function sendVerificationEmail(email, username, token) {
  // reserved test domains (staging test accounts, example.com, *.invalid) are never emailed
  if (guard.undeliverable(email)) {
    console.log('[auth] verification email skipped (reserved test domain)');
    return;
  }
  const link = `https://publicaccess.tv/verify-email?token=${token}`;
  const msg = {
      to: email,
      from: 'no-reply@publicaccess.tv',
      subject: 'Verify Your Email Address',
      text: `Hello ${username}, please verify your email address by clicking on this link: ${link}`,
      html: `Hello <strong>${username}</strong>,<br><br>Please verify your email address by clicking on this link: <a href="${link}">Verify Email</a>.`,
  };

  // 1.99aim: through mailer.js (Resend first, then SendGrid), like the password-reset mail - it used to call SendGrid only,
  // and a dead SendGrid key (401) lost every verification email; the log line names the providers, never the address
  try {
      const via = await mailer.send(msg);
      console.log(`[auth] verification email sent (${via})`);
  } catch (error) {
      console.error(`[auth] verification email failed: ${error.message}`);
  }
}


// 1.99jr: the one way a sign-in finishes - password (loginUser) and Sign in with Plex (plexsso.js). Any sign-in gate
// (a ban, 2FA) belongs HERE so every path gets it; today a sign-in brings an archived account back (1.99bm) and issues
// the 90-day sliding login (middleware/loginCookie.js). Site restrictions (casino ban, feed bans, red list) are not
// sign-in blocks - they're enforced where they apply, whichever way the member signed in.
// 1.99wj: the login is a server-side session (sessions.js: "Your devices", sign out everywhere) - `via` names the method.
function methodOf(via) {
  const v = String(via || "").toLowerCase();
  for (const m of ["plex", "google", "apple", "telegram", "discord", "twitch", "claim"]) if (v.includes(m)) return m;
  if (v.includes("chat")) return "chat";
  return "password";
}
async function finishLogin(req, res, user, via, opts = {}) {
  await require("./staleaccounts").touch(user.userId, via || "sign-in");
  await require("./sessions").signIn(req, res, user, opts.method || methodOf(via), { signup: /sign-up|signup/i.test(String(via || "")) || !!opts.signup });
  return user;
}

// 1.99jr: an account made from a single-sign-on identity (Sign in with Plex, plexsso.js) - the SAME rules as the sign-up
// form: the per-IP new-account limit, the username rules + unique in any letter case, Terms, the vesting welcome bonus
// (welcome.enroll, with the provider identity so one Plex account can't farm it), the fresh_meat badge. The email is
// the provider's: verified only when the provider says so (an unverified one gets the usual verification email), and
// left out when another account already uses it. The password is random (they sign in with the provider, or reset it).
// -> {user} or {error, field}
async function createSsoAccount(req, res, { username, email, emailVerified, provider, identity }) {
  const ip = guard.clientIp(req);
  const wait = registerLimit.blocked(ip);
  if (wait) return { error: req.t ? req.t('auth.err.too_many_accounts', { wait: guard.waitText(wait, req) }) : `Too many new accounts from your network. Try again in ${guard.waitText(wait)}.` };
  username = String(username == null ? "" : username).trim();
  const problem = guard.checkUsername(username, req);   // (1.99ajw padppl rework: a Camfrog login Pepe has seen is never refused - see hint below)
  if (problem) return { error: problem, field: "username" };
  // 1.99ajn padppl: a network ban (netban.js) refuses a new account from that network before it exists
  try { const NB = require("./netban"); if (NB.isOn()) { const why = await NB.refusal(req, {}); if (why) return { error: why }; } } catch (e) { /* fail open */ }
  if ((await getQuery("SELECT 1 FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1", [username])).length)
    return { error: req.t ? req.t('auth.err.username_taken') : "That username is taken. Try another one.", field: "username" };
  let mail = String(email == null ? "" : email).trim();
  if (!(mail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))) mail = "";
  if (mail && (await getQuery("SELECT 1 FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1", [mail])).length) mail = "";   // never someone else's
  const userId = uuidv4();
  const hashed = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 12);
  try {
    await runQuery("INSERT INTO users (userId, username, displayname, password, email, isEmailVerified, points_balance, xp, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   [userId, username, username, hashed, mail || null, mail && emailVerified ? 1 : 0, 0, 0, "/public/img/avatar.png"]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return { error: req.t ? req.t('auth.err.just_taken') : "That username or email was just taken. Try another one.", field: "username" };
    throw e;
  }
  registerLimit.hit(ip);
  await require("./ssolinks").markPassword(userId, false);   // 1.99lb: a random password - the last-method guard counts it as none
  console.log(`[auth] new account ${username} (${userId}) via ${provider}`);
  const termsMod = require("./terms");
  if (termsMod.enforced()) await termsMod.accept(userId).catch((e) => console.error("[auth] terms accept:", e.message));
  await displaynames.markNewAccount(userId).catch(() => {});
  await require("./welcome").enroll(userId, provider, req, res, identity);
  if (mail && !emailVerified) {
    try { const token = generateValidationToken(); await updateUserWithToken(userId, token); sendVerificationEmail(mail, username, token); }
    catch (e) { console.error("[auth] verification setup failed:", e.message); }
  }
  try { await awardBadge(userId, "fresh_meat"); } catch (e) { console.error("[auth] fresh_meat badge:", e.message); }
  // 1.99ajw padppl rework: the gentle "Is <name> your Camfrog name?" hint (cfnames.nameHint) - the caller flashes it AFTER its welcome line
  const hint = await require("./cfnames").nameHint(username, userId, req);
  return { user: { userId, username, class: "pleb" }, ...(hint ? { hint } : {}) };
}

// Function to handle user login. Username (any case) or email; never logs the password.
async function loginUser(req, res) {
  const body = req.body || {};
  const ident = String(body.username == null ? "" : body.username).trim().slice(0, 254);
  const password = typeof body.password === "string" ? body.password : "";
  const next = guard.safeNext(body.next);
  const back = (msg, field) => backTo(req, res, "/login", next, msg, { username: ident, field });

  if (!guard.authFormOk(req)) return res.status(403).send(guard.FORM_REFUSED);   // 1.99zl
  if (!ident) return back(req.t ? req.t('auth.login.username_required') : "Enter your username or email.", "username");
  if (!password) return back(req.t ? req.t('auth.login.password_required') : "Enter your password.", "password");

  const ip = guard.clientIp(req);
  const who = ident.toLowerCase();
  const wait = Math.max(loginPairLimit.blocked(ip + "|" + who), loginNameLimit.blocked(who), loginIpLimit.blocked(ip));
  if (wait) return back(req.t ? req.t('auth.err.too_many_logins', { wait: guard.waitText(wait, req) }) : `Too many sign-in attempts. Try again in ${guard.waitText(wait)}, or reset your password.`);

  try {
    const byEmail = ident.includes("@");
    const rows = byEmail
      ? await getQuery("SELECT userId, username, class, password FROM users WHERE LOWER(email) = LOWER(?) LIMIT 5", [ident])
      : await getQuery("SELECT userId, username, class, password FROM users WHERE LOWER(username) = LOWER(?) ORDER BY (username = ?) DESC LIMIT 5", [ident, ident]);
    let user = null;
    for (const r of rows) {
      if (r.password && (await bcrypt.compare(password, r.password))) { user = r; break; }
    }
    if (!rows.length) await bcrypt.compare(password, await dummyHash());
    if (!user) {
      loginPairLimit.hit(ip + "|" + who);
      loginNameLimit.hit(who);
      loginIpLimit.hit(ip);
      return back(req.t ? req.t('auth.err.bad_login') : "That username and password don't match. Check caps lock, or reset your password.", "password");
    }
    loginPairLimit.reset(ip + "|" + who);
    if (next && next.startsWith("/claim/")) await finishLogin(req, res, user, "claim sign-in");   // 1.99wj: the session's method (a !signup claim link)
    else await finishLogin(req, res, user, "sign-in");
    // 1.99jr: "I already have an account" after a Plex sign-in that wasn't linked yet - link it now (plexsso.js; only
    // when this form asked for it, and only the Plex account THIS browser just signed in to)
    if (body.link_plex === "1") await require("./plexsso").linkPendingTo(req, user).catch((e) => console.error("[auth] plex link after sign-in:", e.message));
    // 1.99lb: the same for Sign in with Telegram / Google (ssolinks.js) - only the provider this form names
    if (body.link_sso && /^[a-z]{2,16}$/.test(String(body.link_sso))) await require("./ssolinks").linkPendingTo(req, user, String(body.link_sso)).catch((e) => console.error("[auth] sso link after sign-in:", e.message));
    return res.redirect(next || `/u/${encodeURIComponent(user.username)}/wheel`);
  } catch (err) {
    // 1.99ajn padppl (review fix): a network ban's refusal (sessions.signIn, netban.js) is shown as itself on the form - it never names an address
    if (err && err.code === "network") return back(err.message);
    console.error("[auth] login error:", err && err.message);
    return back(req.t ? req.t('auth.err.login_failed') : "Something went wrong signing you in. Please try again.");
  }
}

// Update username
async function updateUsername(req, res) {
  const username = String((req.body && req.body.username) || '').trim();
  const userId = req.user.userId;
  const editPage = ACCOUNT_PAGE + '#account';
  if (!guard.sameSite(req)) return res.status(403).send('Forbidden');
  const problem = guard.checkUsername(username, req);   // 1.99ui: in the member's language (1.99ajw padppl rework: a seen Camfrog login is fine)
  if (problem) {
    req.flash('error', problem);
    return res.redirect(editPage);
  }
        // Taken by anyone else, in any letter case (changing the case of your own name is fine)
        db.get(`SELECT userId FROM users WHERE LOWER(username) = LOWER(?) AND userId != ?`, [username, userId], async (err, user) => {
          if (err) {
              console.error(err.message);
              req.flash('error', 'Error processing request');
              return res.redirect(editPage);
          }
          if (user) {
              req.flash('error', 'Username already taken');
              return res.redirect(editPage);
          }
          // 1.99tc: a name another account used to have stays theirs; every rename is kept in username_history
          const usernames = require('./usernames');
          if (await usernames.reservedFor(username, userId)) {
              req.flash('error', 'That username belonged to another account - pick another');
              return res.redirect(editPage);
          }
          await usernames.ensure();
          await require('./dbUtils').tx(async () => {
              const was = (await getQuery('SELECT username FROM users WHERE userId = ?', [userId]))[0];
              await runQuery('UPDATE users SET username = ? WHERE userId = ?', [username, userId]);
              await usernames.record(userId, was ? was.username : req.user.username, username, 'rename:web');
          });
          req.flash('success', 'Username changed.');
          await require('./cfnames').hintAfter(req, userId, username);   // 1.99ajw padppl rework: the gentle "your Camfrog name?" hint
          // 1.99wj: this device signs in again with the new name - its session ends on the server too (sessions.js)
          if (req.loginSession) await require('./sessions').revoke(req.loginSession.userId, req.loginSession.id, 'username changed').catch(() => {});
          clearLogin(res);
          res.redirect(`/login`);
        });
};

// Update displayname
// A name typed here is the user's own (never replaced automatically). displaynames.validate() rules
// (shared with Pepe's !displayname), capped at displaynames.MAX_LEN; an empty one goes back to the
// automatic name.
async function updateDisplayname(req, res) {
  const { displayname } = req.body || {};
  const userId = req.user.userId;
  const username = req.user.username;
  const r = await displaynames.setByUser(userId, displayname);
  if (r && r.error) req.flash('error', 'Display name not changed: ' + r.error + '.');
  else req.flash('success', r && r.auto ? 'Display name reset to ' + r.displayname + '.' : 'Displayname changed.');
  res.redirect(`/u/${username}/edit`);
};

// Update email with retriggering email verification
async function updateEmail(req, res) {
  const { email } = req.body;
  const userId = req.user.userId;
  const username = req.user.username;
      // Check if the username or email is already taken
      db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err) {
            console.error(err.message);
            req.flash('error', 'Error processing request');
            return res.redirect(ACCOUNT_PAGE + '#account');
        }
        if (user) {
            req.flash('error', 'Email already taken');
            return res.redirect(ACCOUNT_PAGE + '#account');
        }
  
        const token = generateValidationToken();

        await updateUserWithToken(userId, token);
        await sendVerificationEmail(email, username, token);

        await runQuery('UPDATE users SET email = ?, isEmailVerified = 0 WHERE userId = ?', [email, userId]);
        req.flash('success', 'Verification email sent.');
        res.redirect(ACCOUNT_PAGE + '#account');
      });
};

// Update password
async function updatePassword(req, res) {
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  const userId = req.user.userId;
  const username = req.user.username;
  const editPage = ACCOUNT_PAGE + '#password';
  if (!guard.sameSite(req)) return res.status(403).send('Forbidden');
  const problem = guard.checkPassword(password, username);
  if (problem) {
    req.flash('error', problem);
    return res.redirect(editPage);
  }
  const hashedPassword = await bcrypt.hash(password, 12);
  await runQuery('UPDATE users SET password = ? WHERE userId = ?', [hashedPassword, userId]);
  await require('./ssolinks').markPassword(userId, true);   // 1.99lb: a password the member chose (last-method guard)
  // 1.99wj: this device stays signed in (its server-side session, sessions.js); "Sign out my other devices" is ticked by
  // default. A form without the switch (an old cached page) counts as ticked - the safe side.
  const b = req.body || {};
  const others = !b.signout_others_field || b.signout_others === 'on' || b.signout_others === '1' || b.signout_others === 'true';
  const cur = req.loginSession && req.loginSession.id;
  let n = 0;
  if (others) n = await require('./sessions').revokeAll(userId, { except: cur || null, why: 'password changed' });
  if (others && !cur) clearLogin(res);
  req.flash('success', req.t ? req.t(others ? 'settings.password.changed_out' : 'settings.password.changed', { count: n })
                             : (others ? `Password changed. ${n} other device(s) signed out.` : 'Password changed.'));
  res.redirect(others && !cur ? '/login' : editPage);
};

// Change the avatar
async function updateAvatar (req, res) {
  const userId = req.user.userId;
  const username = req.user.username;
  const filePath = path.join(__dirname, req.file.path);
  console.log(filePath);
  try {
      // Resize and crop the image using Sharp
      const resizedImage = await sharp(filePath)
          .resize(200, 200) // Change dimensions as needed
          .jpeg({ quality: 90 })
          .toBuffer();

      // 1.99fc: the image safety check (imagesafety.js; a pass-through while it's switched off). Profile photos must be
      // safe for work (Terms) - a refused picture is never uploaded.
      let sv;
      try { sv = await require('./imagesafety').check({ surface: 'profile_photo', kind: 'image', buf: resizedImage, userId, ref: 'profile:' + userId }); }
      catch (e) { sv = { ok: false, reason: "The safety check couldn't run - try again in a minute." }; }
      if (!sv || sv.ok !== true) {
          fs.unlink(filePath, () => {});
          return res.status(422).json({ success: false, message: (sv && sv.reason) || "That picture can't be used." });
      }

      // Upload to S3
      const s3Response = await s3.upload({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: `avatars/${userId}-${Date.now()}.jpeg`,
          Body: resizedImage,
          ACL: 'public-read'
      }).promise();

              const customDomainURL = s3Response.Location.replace('https://s3.amazonaws.com/', 'https://');

      // Update user's avatar URL in the database
      await runQuery('UPDATE users SET avatar = ? WHERE userId = ?', [customDomainURL, userId]);
      console.error('Successfully uploaded avatar.');
      res.json({ message: "Avatar uploaded successfully." });
  } catch (error) {
      console.error('Failed to upload avatar:', error);
      res.status(500).json({ success: false, message: 'Failed to upload avatar.' });
  } 
  // finally {
  //     // Delete the uploaded file from the server
  //     fs.unlink(filePath, err => {
  //         if (err) console.error('Failed to delete file:', err);
  //     });
  // }
};

// Update discord
async function updateDiscordId(req, res) {
  const { discordId } = req.body;
  const userId = req.user.userId;
  const username = req.user.username;
  await runQuery('UPDATE users SET avatar = ? WHERE discordId = ?', [discordId, userId]);
  req.flash('success', 'Discord changed.');
  res.redirect(ACCOUNT_PAGE + '#connections');
};

// Update twitch
async function updateTwitchId(req, res) {
  const { twitchId } = req.body;
  const userId = req.user.userId;
  const username = req.user.username;
  await runQuery('UPDATE users SET avatar = ? WHERE twitchId = ?', [twitchId, userId]);
  req.flash('success', 'Twitch changed.');
  res.redirect(ACCOUNT_PAGE + '#connections');
};

// Internal helper: complete the camfrog link.
// Handles three cases:
//   1. CF-prefixed auto account with this camfrog username → merge balance + delete it
//   2. Another non-CF account already claims this camfrog username → unlink it (no merge, it's a different user's account)
//   3. No existing account → just set the link
// Assumes ownership has been verified (via chat code).
//
// verifyfix (prod 2026-11-08 00:24Z, the owner: "connecting camfrog gives error message even though it worked"): Pepe's
// POST /api/users/camfrog/verify gave up after 10 s ("couldn't reach the website") while the site took 32 s to finish a merge
// that moved 6 rows - and his retry was told "Invalid or expired" (the code was spent by then). The merge ran OUTSIDE any
// transaction, so each of its few hundred writes (accountMerge.moveUserRows: every user column of all 584 tables) waited at
// dbUtils' write gate for whatever other transaction was open, one after another (~12-18 s on the real schema with other
// transactions back to back; 0.4 s idle). Nothing in it waits on Pepe. Now it is two steps, recorded in camfrog_link_jobs:
//   1. _linkNow - ONE transaction, committed before anything slow: the code is spent, the login leaves the auto / other
//      account (the other account's records re-keyed, its Camfrog badges copied) and lands on this one, and the job row
//      holds the answer (the auto account's PAT and cumulative XP, read here).
//   2. runCamfrogLinkJob - the auto account's merge in ONE transaction of its own (1.99gi: under both accounts' level locks,
//      through its afterMerge settle): it moves exactly once or not at all - a failure rolls ALL of it back (the old path
//      could add the PAT and then fail, leaving it on both accounts) and the job tick retries it. Then the after-steps,
//      in the old order: this account's login re-key (once per change - it ran twice: login_changes #45 + #46), notices
//      waiting for the login, blocks / bans / frog-name gifts on it, the site class (staffroles.reconcile). Each is
//      idempotent, so a retry after a crash repeats nothing.
// The !verify answer waits for step 2 at most CF_LINK_WAIT_MS (600 ms); a repeat !verify of the code that login just used
// gets the same answer again (verifyCamfrogLink). completeCamfrogLink (the !signup claim page) still waits for all of it.
const LINK_WAIT_MS = (() => { const n = Number(process.env.CF_LINK_WAIT_MS); return Number.isFinite(n) && n >= 0 ? n : 600; })();
const LINK_REPLAY_MS = 15 * 60 * 1000;        // a repeat !verify of a used code: "already linked" for this long (the code's own life)
const LINK_RETRY_MAX_MS = 60 * 60 * 1000;     // a failed merge is retried after 1, 2, 4 ... minutes, at most hourly
const LINK_KEEP_MS = 30 * 24 * 3600 * 1000;   // done jobs are kept a month (what each link answered), then pruned
let _linkReadyP = null;
function _linkReady() {
  if (!_linkReadyP) {
    _linkReadyP = (async () => {
      // state: 'merge' (the auto account still to merge) -> 'after' (the after-steps) -> 'done'
      await runQuery(`CREATE TABLE IF NOT EXISTS camfrog_link_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, user_id TEXT NOT NULL, login TEXT NOT NULL, before_login TEXT,
        auto_ids TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, result TEXT, tries INTEGER NOT NULL DEFAULT 0, error TEXT,
        next_at INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS camfrog_link_jobs_code ON camfrog_link_jobs (code)");
      await runQuery("CREATE INDEX IF NOT EXISTS camfrog_link_jobs_due ON camfrog_link_jobs (state, next_at)");
      // the one-time setups the link's transactions use run BEFORE them (a first CREATE inside one would roll back with it)
      await require('./usernames').ensure();
      await require('./loginrekey').ensure();
      await require('./staleaccounts').ensure();
      await require('./ledger').ensure();
      await require('./accountMerge').ensureLog();
      return true;
    })().catch((e) => { _linkReadyP = null; throw e; });
  }
  return _linkReadyP;
}
const _jsonOr = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const _linkJob = async (id) => (await getQuery('SELECT * FROM camfrog_link_jobs WHERE id = ?', [id]))[0] || null;
const _jobAnswer = (job) => Object.assign(_jsonOr(job.result, {}), job.state === 'merge' ? { pending: true } : {});

/** Step 1 (one transaction). -> {jobId, result} | {spent: true} (a !verify of the same code was there first) */
async function _linkNow(userId, camfrogUsername, { code = null } = {}) {
  const cfLower = String(camfrogUsername).toLowerCase().trim();
  await _linkReady();
  const usernames = require('./usernames');
  const LR = require('./loginrekey');
  const stale = require('./staleaccounts');
  return require('./dbUtils').tx(async () => {
    if (code) {
      const d = await runQuery('DELETE FROM pending_camfrog_links WHERE code = ?', [code]);
      if (!d || !d.changes) return { spent: true };
    }
    // 1.99bm: an archived account on this name gets its balance back first, so the merge carries it
    for (const r of await getQuery("SELECT userId FROM users WHERE LOWER(camfrogUsername) = LOWER(?) AND userId != ?", [cfLower, userId])) {
      await stale.touch(r.userId, "camfrog link");
    }
    const autoAccounts = await getQuery(
      "SELECT userId, points_balance, xp, level FROM users WHERE LOWER(camfrogUsername) = LOWER(?) AND userId != ? AND username LIKE 'CF%'",
      [cfLower, userId]);
    const otherAccounts = await getQuery(
      "SELECT userId, username FROM users WHERE LOWER(camfrogUsername) = LOWER(?) AND userId != ? AND username NOT LIKE 'CF%'",
      [cfLower, userId]);
    const me = (await getQuery('SELECT username, camfrogUsername, points_balance, xp, level FROM users WHERE userId = ?', [userId]))[0];
    if (!me) throw new Error(`camfrog link: no account ${userId}`);
    // 1.99tc: the login this account had before (a !verify of a different Camfrog name replaces it) - kept in the login
    // history so Pepe's records under the old login (gangs, stashes, loans...) still resolve to this account
    const before = me.camfrogUsername || null;
    if (before && before.toLowerCase().trim() !== cfLower) await usernames.recordLogin(userId, before, cfLower, 'camfrog:relink');

    let unlinkedFrom = null;
    if (otherAccounts.length > 0) {
      const other = otherAccounts[0];
      console.log(`[CF-RELINK] Unlinking camfrog "${cfLower}" from account ${other.username} (${other.userId})`);
      await runQuery('UPDATE users SET camfrogUsername = NULL WHERE userId = ?', [other.userId]);
      await usernames.recordLogin(other.userId, cfLower, null, 'camfrog:taken');
      // 1.99tj: the other account's records keyed by this login stay ITS records (re-keyed to u:<its id>) - loginrekey.js
      // (verifyfix: once - it ran twice; a savepoint of this transaction)
      await LR.changedSafe(other.userId, cfLower, null, 'camfrog:taken');
      // the Camfrog achievements go with the Camfrog name (quietly: no second XP/PAT)
      const copied = await copyCamfrogBadges(other.userId, userId);
      if (copied) console.log(`[CF-RELINK] copied ${copied} Camfrog achievement(s) to ${userId}`);
      unlinkedFrom = other.username;
    }
    // 1.99bs: the login is unique (users_camfrog_login) - free it on the auto account first
    for (const a of autoAccounts) await runQuery('UPDATE users SET camfrogUsername = NULL WHERE userId = ?', [a.userId]);
    await runQuery('UPDATE users SET camfrogUsername = ? WHERE userId = ?', [cfLower, userId]);

    const auto = autoAccounts[0] || null;
    const result = { websiteUsername: me.username, camfrogUsername: cfLower, merged: !!auto,
                     addedBalance: auto ? Number(auto.points_balance) || 0 : 0,
                     addedXp: auto ? mergeXpOf(me, auto).otherTotal : 0,          // 1.99gg: the cumulative XP
                     unlinkedFrom };
    const now = Date.now();
    const ins = await runQuery(`INSERT INTO camfrog_link_jobs (code, user_id, login, before_login, auto_ids, state, result, created, updated)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                               [code, String(userId), cfLower, before, JSON.stringify(autoAccounts.map((a) => String(a.userId))),
                                auto ? 'merge' : 'after', JSON.stringify(result), now, now]);
    return { jobId: ins && ins.id, result };
  });
}

/** Step 2's merge: the auto account into the linked one, in ONE transaction (+ the afterMerge settle under the level locks). */
async function _mergeLinkJob(job) {
  const userId = String(job.user_id);
  const autoId = _jsonOr(job.auto_ids, [])[0] || null;
  const T = require('./dbUtils').tx;
  if (!autoId) {
    await runQuery("UPDATE camfrog_link_jobs SET state = 'after', updated = ? WHERE id = ? AND state = 'merge'", [Date.now(), job.id]);
    return;
  }
  // 1.99gi: both accounts' level locks (sorted) through the merge and its afterMerge settle, so a game XP award can't
  // interleave with the xp/level write
  await withLevelLocks([userId, String(autoId)], async () => {
    const report = await T(async () => {
      const j = (await getQuery('SELECT state, result FROM camfrog_link_jobs WHERE id = ?', [job.id]))[0];
      if (!j || j.state !== 'merge') return null;                // merged meanwhile
      const answer = _jsonOr(j.result, {});
      const auto = (await getQuery(
        'SELECT userId, points_balance, xp, level, twitchBonus, twitchBonus_at, discordBonus, discordBonus_at, liked FROM users WHERE userId = ?',
        [autoId]))[0];
      if (!auto) {
        console.log(`[CF-MERGE] job #${job.id}: the auto account ${autoId} is gone - nothing to merge`);
        await runQuery("UPDATE camfrog_link_jobs SET state = 'after', result = ?, updated = ? WHERE id = ?",
                       [JSON.stringify(Object.assign(answer, { merged: false, addedBalance: 0, addedXp: 0 })), Date.now(), job.id]);
        return null;
      }
      const me = (await getQuery('SELECT points_balance, xp, level FROM users WHERE userId = ?', [userId]))[0];
      if (!me) throw new Error(`camfrog link: the account ${userId} is gone`);
      // 1.99gg: the cumulative XP of both (mergeXpOf); new levels are paid by afterMerge below
      const mx = mergeXpOf(me, auto);
      const pat = Number(auto.points_balance) || 0;
      console.log(`[CF-MERGE] Merging auto account ${auto.userId} into ${userId}: +PAT ${auto.points_balance}, +XP ${mx.otherTotal} (Lv ${auto.level || 0})`);
      await runQuery(
        `UPDATE users SET
          points_balance = COALESCE(points_balance, 0) + ?,
          xp = ?,
          level = ?,
          liked = COALESCE(liked, 0) + ?,
          twitchBonus = CASE WHEN twitchBonus = 1 OR ? = 1 THEN 1 ELSE 0 END,
          twitchBonus_at = COALESCE(twitchBonus_at, ?),
          discordBonus = CASE WHEN discordBonus = 1 OR ? = 1 THEN 1 ELSE 0 END,
          discordBonus_at = COALESCE(discordBonus_at, ?)
        WHERE userId = ?`,
        [pat, mx.store.xp, mx.store.level, auto.liked || 0,
         auto.twitchBonus, auto.twitchBonus_at, auto.discordBonus, auto.discordBonus_at, userId]
      );
      await runQuery('UPDATE transactions SET userId = ? WHERE userId = ?', [userId, auto.userId]);
      // Everything else the auto account owned (badges, cosmetics, roles, spins, orders…) moves too.
      // Badges left behind used to be awarded AGAIN, with full XP + PAT, once the merged account was
      // active (the auto account had them from the quiet backfill).
      const autoRow = (await getQuery('SELECT * FROM users WHERE userId = ?', [auto.userId]))[0];
      const meRow = (await getQuery('SELECT userId, username FROM users WHERE userId = ?', [userId]))[0];
      // adultgate site: an age confirmation the auto account had carries over (the earliest one is kept)
      if (autoRow && Number(autoRow.age_confirmed_at) > 0) {
        const vcol = 'age_confirmed_v' in autoRow;      // the wording's version moves with it (adultgate.js)
        await runQuery(`UPDATE users SET age_confirmed_at = ?${vcol ? ', age_confirmed_v = ?' : ''} WHERE userId = ? AND (age_confirmed_at IS NULL OR age_confirmed_at > ?)`,
                       vcol ? [Number(autoRow.age_confirmed_at), autoRow.age_confirmed_v || null, userId, Number(autoRow.age_confirmed_at)]
                            : [Number(autoRow.age_confirmed_at), userId, Number(autoRow.age_confirmed_at)]);
      }
      const rep = await moveUserRows(auto.userId, userId);
      console.log(`[CF-MERGE] moved from ${auto.userId}: ${JSON.stringify(rep.moved)}${Object.keys(rep.left).length ? ` LEFT ${JSON.stringify(rep.left)}` : ""}`);
      try {
        await archiveMerged(autoRow, meRow, { via: "camfrog link", balance: pat });
        await logMerge({ via: "camfrog link", from: autoRow || { userId: auto.userId }, to: meRow || { userId }, pat, xp: mx.otherTotal, report: rep });
      } catch (e) { console.error("[CF-MERGE] merge record:", e.message); }
      await ledger.recordMerge(auto.userId, userId, 'camfrog link');   // 1.99ga: late credits follow it here
      await runQuery('DELETE FROM users WHERE userId = ?', [auto.userId]);
      await runQuery("UPDATE camfrog_link_jobs SET state = 'after', result = ?, error = NULL, next_at = NULL, updated = ? WHERE id = ?",
                     [JSON.stringify(Object.assign(answer, { merged: true, addedBalance: pat, addedXp: mx.otherTotal })), Date.now(), job.id]);
      return rep;
    });
    if (report) await afterMerge(userId, report);   // caches, the level-up settle, the auto escrow - after the commit
  });
}

/** Step 2's after-steps (each idempotent, each never throws), in the order the old path ran them. */
async function _afterLinkJob(job) {
  const userId = String(job.user_id), cfLower = String(job.login);
  const LR = require('./loginrekey');
  // 1.99tj: this account's records keyed by its previous login move to the new one (loginrekey.js) - once per change
  // (verifyfix: it ran twice; a retried job doesn't record it again)
  const oldKey = LR.keyOf(job.before_login, userId), newKey = LR.keyOf(cfLower, userId);
  if (oldKey !== newKey) {
    const had = (await getQuery('SELECT 1 FROM login_changes WHERE userId = ? AND old_key = ? AND new_key = ? AND at >= ? LIMIT 1',
                                [userId, oldKey, newKey, Number(job.created) || 0]))[0];
    if (!had) await LR.changedSafe(userId, job.before_login || null, cfLower, 'camfrog:relink');
  }
  await inbox.attachPendingSafe(userId, cfLower);   // notices Pepe sent this name before it had an account
  // 1.99ajn padppl: blocks / website bans made on this login before it had an account follow it onto the account (never throws)
  try { await require("./blocks").linked(userId, cfLower); } catch (e) { /* blocks.js logs */ }
  try { await require("./padbans").linked(userId, cfLower); } catch (e) { /* padbans.js logs */ }
  try { await require("./veilgift").linked(userId, cfLower); } catch (e) { /* veilgift.js logs */ }
  // D11-site-roles: the site class follows this login's role now (staffroles.reconcile - not 5 minutes later): a relink
  // from a login with a role dropped the class it gave (staffroles' unlink trigger), and this one gives its own back
  await require('./staffroles').reconcile([cfLower]).catch((e) => console.error('[CF-VERIFY] roles:', e.message));
}

const _linkRuns = new Map();       // job id -> its run (one at a time per job; the site runs in one process)
/** Step 2 for one job. -> the answer ({websiteUsername, camfrogUsername, merged, addedBalance, addedXp, unlinkedFrom}).
 *  Throws when the merge failed (the job keeps the error and its next try; the tick retries it). */
function runCamfrogLinkJob(id) {
  const k = Number(id);
  if (_linkRuns.has(k)) return _linkRuns.get(k);
  const p = _runLinkJob(k).finally(() => { _linkRuns.delete(k); });
  _linkRuns.set(k, p);
  return p;
}
async function _runLinkJob(id) {
  await _linkReady();
  let job = await _linkJob(id);
  if (!job) return null;
  const t0 = Date.now();
  let step = 'merge';
  try {
    if (job.state === 'merge') {
      await _mergeLinkJob(job);
      job = await _linkJob(id);
    }
    if (job && job.state === 'after') {
      step = 'after-steps';
      await _afterLinkJob(job);
      await runQuery("UPDATE camfrog_link_jobs SET state = 'done', error = NULL, next_at = NULL, updated = ? WHERE id = ? AND state = 'after'", [Date.now(), id]);
      job = await _linkJob(id);
      console.log(`[CF-LINK] job #${id} done in ${Date.now() - t0} ms`);
    }
  } catch (e) {
    // kept for the tick: tried again after 1, 2, 4 ... minutes (at most hourly); the merge's own transaction rolled back whole
    const tries = (Number(job && job.tries) || 0) + 1;
    const wait = Math.min(LINK_RETRY_MAX_MS, 60000 * Math.pow(2, Math.min(tries - 1, 10)));
    const msg = String((e && e.message) || e).slice(0, 500);
    await runQuery("UPDATE camfrog_link_jobs SET tries = ?, error = ?, next_at = ?, updated = ? WHERE id = ? AND state != 'done'",
                   [tries, msg, Date.now() + wait, Date.now(), id]).catch(() => {});
    console.error(`[CF-LINK] job #${id}: the ${step} failed (try ${tries}; again in ${Math.round(wait / 1000)} s): ${msg}`);
    throw e;
  }
  return job ? _jobAnswer(job) : null;
}
/** The tick: jobs that aren't done and are due (a failed merge, a run a restart cut short). -> how many finished */
async function runCamfrogLinkJobs({ now = Date.now(), limit = 10 } = {}) {
  await _linkReady();
  const due = await getQuery("SELECT id FROM camfrog_link_jobs WHERE state != 'done' AND (next_at IS NULL OR next_at <= ?) ORDER BY id LIMIT ?",
                             [now, limit]);
  let n = 0;
  for (const { id } of due) {
    try { await runCamfrogLinkJob(id); n++; } catch (e) { /* logged by the run; tried again when due */ }
  }
  await runQuery("DELETE FROM camfrog_link_jobs WHERE state = 'done' AND updated < ?", [now - LINK_KEEP_MS]).catch(() => {});
  return n;
}
/** Every job run that is under way has finished (tests). */
async function settleCamfrogLinks() {
  while (_linkRuns.size) await Promise.allSettled([..._linkRuns.values()]);
}
let _linkTimer = null;
/** index.js: the retry tick (a minute; the first 15 s after start, for a run a restart cut short). */
function startCamfrogLinkJobs({ everyMs = 60000 } = {}) {
  if (_linkTimer) return;
  const tick = () => { runCamfrogLinkJobs().catch((e) => console.error('[CF-LINK] tick:', e.message)); };
  const first = setTimeout(tick, 15000);
  if (first.unref) first.unref();
  _linkTimer = setInterval(tick, everyMs);
  if (_linkTimer.unref) _linkTimer.unref();
}

/** Link `camfrogUsername` to `userId` and merge its auto account - all of it before this returns (the !signup claim page,
 *  autoescrow.redeemClaim). Throws when the merge failed (the link stands; the job tick retries the merge). */
async function completeCamfrogLink(userId, camfrogUsername) {
  const a = await _linkNow(userId, camfrogUsername);
  const r = (await runCamfrogLinkJob(a.jobId)) || a.result;
  return { merged: !!r.merged, addedBalance: r.addedBalance || 0, addedXp: r.addedXp || 0, unlinkedFrom: r.unlinkedFrom || null };
}

// Step 1: Initiate camfrog link — generates a verification code the user must type in chat.
// Does NOT update camfrogUsername yet. Prevents account hijacking.
async function updateCamfrogUsername(req, res) {
  const { camfrogUsername } = req.body;
  const userId = req.user.userId;
  const username = req.user.username;
  const cfLower = (camfrogUsername || '').toLowerCase().trim();

  // Empty string = unlink
  if (!cfLower) {
    const was = ((await getQuery('SELECT camfrogUsername FROM users WHERE userId = ?', [userId]))[0] || {}).camfrogUsername;
    await runQuery('UPDATE users SET camfrogUsername = ? WHERE userId = ?', [null, userId]);
    if (was) await require('./usernames').recordLogin(userId, was, null, 'camfrog:unlink');   // 1.99tc: login history
    if (was) await require('./loginrekey').changedSafe(userId, was, null, 'camfrog:unlink');   // 1.99tj: records follow the account
    if (was) await require('./loginrekey').changedSafe(userId, was, null, 'camfrog:unlink');   // 1.99tj: records follow the account
    req.flash('success', 'Camfrog username unlinked.');
    return res.redirect(ACCOUNT_PAGE + '#connections');
  }

  try {
    // Check if the user is already linked to this same camfrog username — no-op
    const me = await getQuery('SELECT camfrogUsername FROM users WHERE userId = ?', [userId]);
    if (me[0]?.camfrogUsername && me[0].camfrogUsername.toLowerCase() === cfLower) {
      req.flash('success', 'Camfrog username already linked.');
      return res.redirect(ACCOUNT_PAGE + '#connections');
    }

    // Check if another non-CF account already owns this camfrog username
    const claimed = await getQuery(
      "SELECT userId, username FROM users WHERE LOWER(camfrogUsername) = LOWER(?) AND userId != ? AND username NOT LIKE 'CF%'",
      [cfLower, userId]
    );

    // Clear any old pending verification for this user
    await runQuery('DELETE FROM pending_camfrog_links WHERE userId = ?', [userId]);

    // Generate a verification code: 6 random alphanumeric chars
    const code = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();  // 15 min

    await runQuery(
      'INSERT INTO pending_camfrog_links (code, userId, camfrogUsername, expires_at) VALUES (?, ?, ?, ?)',
      [code, userId, cfLower, expiresAt]
    );

    if (claimed.length > 0) {
      req.flash('error', `Warning: "${camfrogUsername}" is currently linked to account "${claimed[0].username}". Verifying will unlink it from that account and move it to yours. !verify ${code}`);
    } else {
      req.flash('success', `Verify ownership of "${camfrogUsername}" to complete the link. !verify ${code}`);
    }
    // 1.99ajw quick1: the code box is at the TOP of the page (partials/account-flash.ejs) - the address points at it, not at
    // #connections further down where it couldn't be seen (even with scripts off); its script brings it into view and
    // moves focus to it
    return res.redirect(ACCOUNT_PAGE + '#cf-verify');
  } catch (err) {
    console.error('[CF-LINK] Initiate error:', err);
    req.flash('error', 'Failed to initiate Camfrog link.');
  }
  res.redirect(ACCOUNT_PAGE + '#connections');
};

// Step 2: Bot calls this when a user types !verify CODE in Camfrog chat.
// Body: { code, camfrogUsername (from chat author), password (bot token) }
// Verifies the chat author's username matches the pending link, then completes it.
// verifyfix: the answer is the link's (committed first) and comes at once - the auto account's merge is waited for at most
// CF_LINK_WAIT_MS (see completeCamfrogLink above); a repeat !verify of the code that login just used (Pepe's retry after
// his 10 s timeout) answers 200 again with the same payload + already: true (frida-bot.py handle_verify reads success,
// websiteUsername, unlinkedFrom, merged, addedBalance, addedXp).
function _verifyPayload(r, extra = {}) {
  return Object.assign({
    success: true,
    websiteUsername: r.websiteUsername,
    camfrogUsername: r.camfrogUsername,
    merged: !!r.merged,
    addedBalance: r.addedBalance || 0,
    addedXp: r.addedXp || 0,
    unlinkedFrom: r.unlinkedFrom || null,
  }, r.pending ? { pending: true } : {}, extra);
}
/** The answer again for the login that used `code` within LINK_REPLAY_MS and is still linked to that account; else null. */
async function _linkReplay(code, login) {
  await _linkReady();
  const j = (await getQuery('SELECT * FROM camfrog_link_jobs WHERE code = ? ORDER BY id DESC LIMIT 1', [code]))[0];
  if (!j || String(j.login) !== login || Date.now() - Number(j.created) > LINK_REPLAY_MS) return null;
  const u = (await getQuery('SELECT username, camfrogUsername FROM users WHERE userId = ?', [j.user_id]))[0];
  if (!u || String(u.camfrogUsername || '').toLowerCase().trim() !== login) return null;     // unlinked / moved on since
  return _verifyPayload(Object.assign(_jobAnswer(j), { websiteUsername: u.username }), { already: true });
}
const _within = (p, ms) => {
  let t = null;
  return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(null), ms); })]).finally(() => clearTimeout(t));
};
async function verifyCamfrogLink(req, res) {
  const t0 = Date.now();
  const { code, camfrogUsername, password } = req.body;
  if (!require('./botkeys').isBotToken(password)) {   // 1.99acf: botkeys.js (a key caller, or the shared token - counted)
    return res.status(403).json({ error: 'Invalid bot token' });
  }
  if (!code || !camfrogUsername) {
    return res.status(400).json({ error: 'Missing code or camfrogUsername' });
  }

  try {
    const C = String(code).toUpperCase().trim();
    const who = String(camfrogUsername).toLowerCase().trim();
    const pending = await getQuery(
      'SELECT userId, camfrogUsername, expires_at FROM pending_camfrog_links WHERE code = ?',
      [C]
    );
    if (pending.length === 0) {
      const again = await _linkReplay(C, who);
      if (again) {
        console.log(`[CF-VERIFY] a repeat of a code just used - already linked (answered in ${Date.now() - t0} ms)`);
        return res.json(again);
      }
      return res.status(404).json({ error: 'Invalid or expired verification code' });
    }

    const entry = pending[0];
    if (new Date(entry.expires_at) < new Date()) {
      await runQuery('DELETE FROM pending_camfrog_links WHERE code = ?', [C]);
      return res.status(410).json({ error: 'Verification code expired' });
    }

    // Critical: confirm the chat author's username matches the username they claimed
    if (entry.camfrogUsername.toLowerCase() !== who) {
      return res.status(403).json({
        error: `Code belongs to camfrog user "${entry.camfrogUsername}", not "${camfrogUsername}". Each user must verify their own link.`
      });
    }

    // the link itself, committed (the code is spent in the same transaction)
    const a = await _linkNow(entry.userId, entry.camfrogUsername, { code: C });
    if (a.spent) {                                   // a !verify of the same code got there first
      const again = await _linkReplay(C, who);
      if (again) {
        console.log(`[CF-VERIFY] the same code twice at once - already linked (answered in ${Date.now() - t0} ms)`);
        return res.json(again);
      }
      return res.status(404).json({ error: 'Invalid or expired verification code' });
    }
    const tLink = Date.now() - t0;
    const run = runCamfrogLinkJob(a.jobId);
    run.catch(() => {});                             // a failed merge is logged and kept for the job tick
    const done = await _within(run.then((r) => r, () => null), LINK_WAIT_MS);
    const r = done || Object.assign({}, a.result, a.result.merged ? { pending: true } : {});
    console.log(`[CF-VERIFY] job #${a.jobId} answered in ${Date.now() - t0} ms (link ${tLink} ms; ${done ? 'merge + after-steps done' : 'the rest continues in the background'})`);
    res.json(_verifyPayload(r));
  } catch (err) {
    console.error('[CF-VERIFY] Error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
};

// Calculate XP for next level
function xpForNextLevel(currentLevel) {
  return Math.pow(currentLevel + 1, 2) * 1000;
};

// Update Levels
// Level-ups are serialised per user: updateLevel reads xp/level, awaits the reward payouts, then
// writes back - two concurrent calls for one user (e.g. an achievement + a spin in the same second)
// both saw the old values, BOTH paid the level-up reward and one overwrote the other's XP
// (CFi00snkcl got "Level-up reward (Lv 4)" twice at 23:23:17 on 2026-10-05).
// 1.99gi: the lock is RE-ENTRANT per async context (AsyncLocalStorage holds the ids this call chain already
// holds), so a merge that holds both accounts' locks can run afterMerge -> updateLevel(survivor) without
// queueing behind itself. Every account merge holds BOTH accounts' locks (withLevelLocks, sorted ids) for
// its whole transaction + the afterMerge settle, so a game XP award for either account waits for the merge
// instead of being overwritten by it (or landing on the old row mid-merge).
const { AsyncLocalStorage } = require("async_hooks");
const _levelHeld = new AsyncLocalStorage();
const _levelLocks = new Map();
function _withLevelLock(userId, fn) {
  const key = String(userId);
  const held = _levelHeld.getStore();
  // re-entrant only while the holding call is still running: fire-and-forget work started under the lock
  // (achievements.checkWeb...) inherits the context but runs after the release, so it must queue normally
  const mine = held && held.get(key);
  if (mine && mine.active) return Promise.resolve().then(fn);
  const prev = _levelLocks.get(key) || Promise.resolve();
  const token = { active: true };
  const inner = new Map(held || []); inner.set(key, token);
  const run = prev.catch(() => {}).then(() => _levelHeld.run(inner, fn)).finally(() => { token.active = false; });
  const tail = run.catch(() => {});
  _levelLocks.set(key, tail);
  tail.then(() => { if (_levelLocks.get(key) === tail) _levelLocks.delete(key); });
  return run;
}
/**
 * Hold the level lock of every id in `ids` while fn runs (account merges: the survivor AND the source).
 * Taken one at a time in sorted order, so two merges sharing an account can't deadlock whichever way
 * round they name it.
 */
function withLevelLocks(ids, fn) {
  const sorted = [...new Set((ids || []).filter(Boolean).map(String))].sort();
  const step = (i) => (i >= sorted.length ? Promise.resolve().then(fn) : _withLevelLock(sorted[i], () => step(i + 1)));
  return step(0);
}
/** The ids of the level locks this async call chain holds (tests / assertions). */
function heldLevelLocks() { return [...(_levelHeld.getStore() || new Map())].filter(([, t]) => t.active).map(([k]) => k); }

// An award for an account that a merge has since deleted follows ledger account_merges to the account it
// was merged into (1.99gi; it used to log "User not found" and drop the XP). The redirect runs AFTER the
// old id's lock is released, so it never holds one lock while waiting for another out of order.
const _MERGED = Symbol("merged");
async function updateLevel(userId, additionalXp) {
  let id = userId;
  for (let hop = 0; hop < 6; hop++) {
    const r = await _withLevelLock(id, () => _updateLevelLocked(id, additionalXp));
    if (!r || !r[_MERGED]) return r;
    console.log(`[levelup] ${additionalXp} XP for merged account ${id} -> ${r[_MERGED]}`);
    id = r[_MERGED];
  }
  return null;
}

// ── Admin XP / level adjustments (1.99cy: the Users & Accounts "XP" card, POST /api/admin/update-level) ──
// An admin can add (or take away) XP, or set a level outright. Decisions:
//   * NO level-up rewards: an admin adjustment never pays the 25k per-level reward or a milestone bonus, and
//     writes nothing to levelup_rewards / levelup_milestones - so if the levels are later taken away and the
//     member earns them again by playing, those levels pay normally then. Owed milestones aren't retried here.
//   * Level-unlock cosmetics and level achievements DO follow the new level (they're derived from it, not PAT).
//   * Serialised with updateLevel through the same per-user lock, so it can't interleave with a game award.
//   * Every applied change is an admin audit event (adminaudit.js, action "xp").
const ADMIN_XP_MAX = 50000000;           // |XP| per adjustment
const ADMIN_LEVEL_MAX = 200;
/** All the XP it takes to reach `level` from level 0, plus `xp` into the next one. */
function totalXpOf(level, xp) {
  let n = 0;
  for (let l = 0; l < level; l++) n += xpForNextLevel(l);
  return n + (Number(xp) || 0);
}
/** The (level, xp) a total amount of XP comes to. */
function levelOfTotal(total) {
  let level = 0, xp = Math.max(0, Math.floor(total));
  while (level < 100000 && xp >= xpForNextLevel(level)) { xp -= xpForNextLevel(level); level++; }
  return { level, xp };
}
/**
 * 1.99gg: the XP of two accounts being merged - EVERY account merge uses this (accountMerge.carryUserFields:
 * the duplicate merge + the Twitch/Discord provider merge; completeCamfrogLink: the Camfrog !verify merge).
 * `xp` is "into the current level", so a merge adds the two CUMULATIVE totals. It used to keep the higher
 * level and add only the two in-level amounts, which dropped all the XP the lower account had spent reaching
 * its level (32 past !verify merges: 144,000 XP short).
 * -> {total, level, xp (= levelOfTotal(total)), maxLevel, otherTotal (what `other` brings), store: {level, xp}}
 * `store` is what the merge writes inside its transaction: the higher of the two levels and the rest of the
 * total as in-level XP. When that's enough for further levels, accountMerge.afterMerge() runs the normal
 * updateLevel(id, 0) once the merge has committed: it settles to exactly {level, xp} and pays those NEW
 * levels' rewards through levelup_rewards / levelup_milestones (deduped - a level either account was already
 * paid for isn't paid again, and levels up to the higher of the two never pay). Should that step not run,
 * the next XP award settles it the same way.
 */
function mergeXpOf(survivor, other) {
  const n = (x) => Math.max(0, Math.floor(Number(x) || 0));
  const s = { level: n(survivor && survivor.level), xp: n(survivor && survivor.xp) };
  const o = { level: n(other && other.level), xp: n(other && other.xp) };
  const otherTotal = totalXpOf(o.level, o.xp);
  const total = totalXpOf(s.level, s.xp) + otherTotal;
  const maxLevel = Math.max(s.level, o.level);
  const settled = levelOfTotal(total);
  return { total, level: settled.level, xp: settled.xp, maxLevel, otherTotal,
           store: { level: maxLevel, xp: total - totalXpOf(maxLevel, 0) } };
}
/** Check an admin adjustment's input. -> {mode, amount} or throws {status:400, message}. */
function checkXpAdjust(mode, amount) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (mode !== "add" && mode !== "set_level") throw bad("Pick add XP or set level.");
  const s = String(amount == null ? "" : amount).trim();
  if (!/^-?\d+$/.test(s)) throw bad(mode === "add" ? "XP must be a whole number (negative takes XP away)." : "The level must be a whole number.");
  const n = Number(s);
  if (mode === "add") {
    if (n === 0) throw bad("Adding 0 XP changes nothing.");
    if (Math.abs(n) > ADMIN_XP_MAX) throw bad(`At most ${ADMIN_XP_MAX.toLocaleString("en-US")} XP at a time.`);
  } else if (n < 0 || n > ADMIN_LEVEL_MAX) throw bad(`The level must be between 0 and ${ADMIN_LEVEL_MAX}.`);
  return { mode, amount: n };
}
function _xpPlan(cur, mode, amount) {
  const before = { level: Number(cur.level) || 0, xp: Math.floor(Number(cur.xp) || 0) };
  const after = mode === "add" ? levelOfTotal(totalXpOf(before.level, before.xp) + amount) : { level: amount, xp: 0 };
  return { before, after, xpDelta: totalXpOf(after.level, after.xp) - totalXpOf(before.level, before.xp) };
}
/**
 * Preview (apply = false) or apply an admin adjustment. -> {before, after, xpDelta, applied}
 * The caller has checked the admin and the input (checkXpAdjust); onApplied(plan) records the audit event.
 */
function adminAdjustXp(userId, { mode, amount }, { apply = false, onApplied = null, check = null } = {}) {
  const go = async () => {
    const row = (await getQuery("SELECT xp, level FROM users WHERE userId = ?", [userId]))[0];
    if (!row) throw Object.assign(new Error("No such account."), { status: 404 });
    const plan = _xpPlan(row, mode, amount);
    if (check) await check(plan);        // rankrule review fix: the caller's refusal (throws) on the plan, before anything is written
    if (!apply) return { ...plan, applied: false };
    await runQuery("UPDATE users SET xp = ?, level = ? WHERE userId = ?", [plan.after.xp, plan.after.level, userId]);
    if (plan.after.level > plan.before.level) {
      try { require("./achievements").checkWeb(userId); } catch (e) { /* best effort */ }
      require("./cosmetics").grantUnlocks(userId, { level: plan.after.level }).catch(() => {});
    }
    if (onApplied) await onApplied(plan);
    console.log(`[xp] admin adjustment ${userId}: Lv ${plan.before.level} (${plan.before.xp}) -> Lv ${plan.after.level} (${plan.after.xp}), no rewards`);
    return { ...plan, applied: true };
  };
  return apply ? _withLevelLock(userId, go) : go();
}

// Level-up rewards (1.99ax, "option E"): every level pays LEVELUP_BASE_REWARD; a level that's a
// multiple of LEVELUP_MILESTONE_EVERY also pays a milestone bonus of LEVELUP_MILESTONE_UNIT x (L / 5)
// (Lv 5 = 250k, Lv 10 = 500k, Lv 25 = 1.25M, Lv 50 = 2.5M) and unlocks that milestone's level
// cosmetics (cosmetics.json, unlock.level). Everything is paid OUT of the vault the "levelup" payout
// row names (the Federal Reserve) - never minted. No settings table covers these, so they're
// constants: change them here (a cap can come later if the Reserve drains too fast).
//   base:      skipped when the Reserve can't cover it (as before).
//   milestone: kept as OWED when the Reserve can't cover it, and retried on that user's later XP
//              awards until it's paid. The cosmetics are granted either way.
const LEVELUP_BASE_REWARD = 25000;
const LEVELUP_MILESTONE_EVERY = 5;
const LEVELUP_MILESTONE_UNIT = 250000;
const milestoneReward = (level) =>
  (level > 0 && level % LEVELUP_MILESTONE_EVERY === 0) ? LEVELUP_MILESTONE_UNIT * (level / LEVELUP_MILESTONE_EVERY) : 0;
const levelReward = (level) => LEVELUP_BASE_REWARD + milestoneReward(level);

// Each (user, level) reward is paid at most once, ever - recorded before paying, so a retry, a
// second code path or a restart can't pay a level twice. Milestones have their own record.
const _levelRewardsReady = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS levelup_rewards (
    userId TEXT NOT NULL, level INTEGER NOT NULL, amount INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0,
    created DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, level))`);
  await runQuery(`CREATE TABLE IF NOT EXISTS levelup_milestones (
    userId TEXT NOT NULL, level INTEGER NOT NULL, amount INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0,
    created DATETIME DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME, PRIMARY KEY (userId, level))`);
})().catch((e) => console.error("[levelup] tables:", e.message));

/** Pay this user's owed milestone bonuses (oldest first) while the Reserve covers them. The row is
 *  flipped to paid before the payout and flipped back if the Reserve can't cover it. */
async function _payOwedMilestones(userId) {
  let total = 0;
  const owed = await getQuery("SELECT level, amount FROM levelup_milestones WHERE userId = ? AND paid = 0 ORDER BY level", [userId]);
  for (const m of owed) {
    const take = await runQuery("UPDATE levelup_milestones SET paid = 1, paid_at = CURRENT_TIMESTAMP WHERE userId = ? AND level = ? AND paid = 0",
                                [userId, m.level]);
    if (!take || !take.changes) continue;
    const fr = await funding.fundPayout(userId, m.amount, "levelup", `Level ${m.level} milestone`);
    if (fr) {
      if (fr !== "queued") total += m.amount;            // E-2: a queued milestone is owed, paid by the queue
    } else {
      await runQuery("UPDATE levelup_milestones SET paid = 0, paid_at = NULL WHERE userId = ? AND level = ?", [userId, m.level]);
      break;                                            // the Reserve is short - try again next time
    }
  }
  return total;
}

async function _updateLevelLocked(userId, additionalXp) {
  await _levelRewardsReady;
  const userDetails = await getQuery("SELECT xp, level FROM users WHERE userId = ?", [userId]);
  if (userDetails.length === 0) {
    // merged away (ledger account_merges)? updateLevel re-runs the award on the survivor once this lock is released
    const to = await ledger.resolveUserId(userId).catch(() => null);
    if (to && to !== String(userId)) return { [_MERGED]: to };
    console.error(`[levelup] user ${userId} not found - ${additionalXp} XP dropped`);
    return null;
  }

  let { xp, level } = userDetails[0];
  xp += additionalXp;

  let totalBonusPoints = 0;
  let levelsGained = 0;
  const milestones = [];

  while (xp >= xpForNextLevel(level)) {
    xp -= xpForNextLevel(level);
    level++;
    levelsGained++;
    // (1.63 made level-ups come out of the Reserve instead of being minted; 1.99ax: option E amounts.)
    const claim = await runQuery("INSERT OR IGNORE INTO levelup_rewards (userId, level, amount) VALUES (?, ?, ?)",
                                 [userId, level, LEVELUP_BASE_REWARD]);
    if (claim && claim.changes) {
      const fr = await funding.fundPayout(userId, LEVELUP_BASE_REWARD, "levelup", `Level-up reward (Lv ${level})`);
      if (fr) {
        // E-2: "queued" = owed by the incentive budget (its queue pays it); recorded as handled, not counted as paid now
        if (fr !== "queued") totalBonusPoints += LEVELUP_BASE_REWARD;
        await runQuery("UPDATE levelup_rewards SET paid = 1 WHERE userId = ? AND level = ?", [userId, level]);
      }
    } else {
      console.log(`[levelup] ${userId} already had the Lv ${level} reward - not paying it again`);
    }
    const bonus = milestoneReward(level);
    if (bonus > 0) {
      const m = await runQuery("INSERT OR IGNORE INTO levelup_milestones (userId, level, amount) VALUES (?, ?, ?)",
                               [userId, level, bonus]);
      if (m && m.changes) milestones.push(level);       // paid just below (or owed)
    }
  }

  await runQuery("UPDATE users SET xp = ?, level = ? WHERE userId = ?", [xp, level, userId]);
  // new milestones + any still owed from when the Reserve couldn't cover them
  const milestonePaid = await _payOwedMilestones(userId).catch((e) => { console.error("[levelup] milestone:", e.message); return 0; });
  totalBonusPoints += milestonePaid;
  if (levelsGained > 0) require("./achievements").checkWeb(userId);   // level achievements
  if (levelsGained > 0) require("./cosmetics").grantUnlocks(userId, { level }).catch(() => {});   // level-unlock cosmetics
  console.log(`User ${userId} is now level ${level} with ${xp} XP.`);

  return {
    leveledUp: levelsGained > 0,
    newLevel: level,
    levelsGained: levelsGained,
    bonusPoints: totalBonusPoints,
    milestones,
    milestonePoints: milestonePaid,
  };
};


// Function to Award Badges
// 1.99gb: idempotent - INSERT OR IGNORE, and the badge's XP is paid only by the call that inserted it. It
// used to throw "Badge already awarded" (which aborted Twitch / Discord linking before the id was saved),
// ran a raw BEGIN on the shared connection (any other request's writes landed in it) and didn't await the
// XP. -> {success: true, awarded: true} when given now, {success: false, awarded: false, already: true} when
// the user already had it. Throws only for an unknown badge.
async function awardBadge(userId, badgeId) {
  const badge = (await getQuery("SELECT points FROM badges WHERE badgeId = ?", [badgeId]))[0];
  if (!badge) throw new Error('Badge not found');
  const r = await runQuery("INSERT OR IGNORE INTO user_badges (userId, badgeId) VALUES (?, ?)", [userId, badgeId]);
  if (!r || r.changes !== 1) {
    return { success: false, awarded: false, already: true, message: `User ${userId} already has badge ${badgeId}.` };
  }
  const points = Number(badge.points) || 0;
  if (points) await updateLevel(userId, points);
  console.log(`Badge ${badgeId} awarded to user ${userId} with ${points} XP added.`);
  return { success: true, awarded: true, message: `Badge ${badgeId} awarded to user ${userId}.` };
};

// Function to Award Bonus PAT

async function awardBonus(userId, type, amount) {
  if (!userId || !amount || !type) {
    console.error("Missing required fields");
  }

  try {
    // 1.63: bonuses are paid OUT of a vault (connect bonuses: "connect_bonus"; anything else:
    // "platform_rewards") and skipped when it can't cover them - never minted.
    // 1.99afh review: platform_rewards is the incentive budget's or nobody's - funding.js refuses it while it isn't routed
    // to "incentives" (never vaultFor's Reserve default), so this path can't make a Reserve claim either.
    const flow = /connect/i.test(String(type)) ? "connect_bonus" : "platform_rewards";
    // 1.99ga: nothing is taken from a vault for an account that isn't there
    if (!(await ledger.userExists(userId))) {
      console.warn(`[bonus] ${type} ${amount} for missing account ${userId} - skipped (${ledger.E_TARGET_NOT_FOUND})`);
      return { success: false, code: ledger.E_TARGET_NOT_FOUND };
    }
    const take = await funding.takeFundsRef(flow, amount, userId, type);
    if (!take.ok) {
      // E-2: a connect bonus / platform reward the incentive budget can't pay yet waits in its queue
      if (funding.vaultFor && funding.vaultFor(flow) === "incentives") {
        const claimId = await funding.queueClaim(userId, amount, flow, type);
        if (claimId) return { success: true, queued: true, claimId };
      }
      return;
    }
    // Start a transaction
    const transactionId = uuidv4();
    const bonusId = uuidv4();
    // 1.99sr: the shared serialized transaction (mainstage tx) - a raw BEGIN here could collide with another module's
    // open transaction, and the catch's bare ROLLBACK then undid THAT request's writes
    const posted = await require("./mainstage")._tx(async () => {
      // Add points to the winner's points balance - logged only when it really moved (1.99ga)
      const p = await ledger.post(userId, Number(amount), "bonus win", { transactionId, resolveMerged: true, source: `bonus ${type}` });
      if (!p.ok) return p;
      await runQuery(
        "INSERT INTO bonus_winners (bonusId, type, userId, transactionId, amount) VALUES (?, ?, ?, ?, ?)",
        [bonusId, type, p.userId, transactionId, amount]
      );
      return p;
    });
    if (!posted.ok) {
      await take.undo();
      return { success: false, code: posted.code };
    }
    console.log(`${amount} PAT bonus points awarded to ${userId} successfully.`)
    return  { success: true, message: `${amount} PAT bonus points awarded to ${userId} successfully.` };
  } catch (error) {
    // 1.99sr: tx() already rolled back its own transaction (a bare ROLLBACK could undo another request's)
    console.error("Failed to process bonus winner:", error);
    throw error; // Rethrow the error so the calling function can handle it
  }
};

module.exports = {
  registerUser,
  loginUser,
  finishLogin,          // 1.99jr
  createSsoAccount,     // 1.99jr
  updateUsername,
  updateEmail,
  updatePassword,
  updateDisplayname,
  updateAvatar,
  updateDiscordId,
  updateTwitchId,
  updateCamfrogUsername,
  verifyCamfrogLink,
  completeCamfrogLink,  // 1.99afx: the !signup claim page (autoescrow.redeemClaim) links through it - it was never exported
  runCamfrogLinkJob,    // verifyfix: a link's merge + after-steps (camfrog_link_jobs)
  runCamfrogLinkJobs,   // verifyfix: the retry tick's pass
  settleCamfrogLinks,   // verifyfix: (tests) the runs under way have finished
  startCamfrogLinkJobs, // verifyfix: index.js starts the retry tick
  awardBadge,
  xpForNextLevel,
  updateLevel,
  withLevelLocks,
  heldLevelLocks,
  adminAdjustXp,
  checkXpAdjust,
  totalXpOf,
  levelOfTotal,
  mergeXpOf,
  levelReward,
  milestoneReward,
  LEVELUP_BASE_REWARD,
  LEVELUP_MILESTONE_UNIT,
  awardBonus,
  generateUniqueUsername,
  normaliseUsername
};