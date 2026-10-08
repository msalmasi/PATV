// user.controller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { issueLogin, clearLogin } = require('./middleware/loginCookie');
const guard = require('./middleware/authGuard');
const sqlite3 = require('sqlite3').verbose()
const { v4: uuidv4 } = require('uuid');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const { createTables, runQuery, getQuery } = require('./dbUtils');
const funding = require('./funding');
const { moveUserRows, copyCamfrogBadges } = require('./accountMerge');
const inbox = require('./inbox');
const displaynames = require('./displaynames');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const AWS = require('aws-sdk');
const upload = multer({ dest: 'uploads/' });

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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

  if (!guard.sameSite(req)) return res.status(403).send("Cross-site sign-up refused");
  const ip = guard.clientIp(req);
  const wait = registerLimit.blocked(ip);
  if (wait) return back(`Too many new accounts from your network. Try again in ${guard.waitText(wait)}.`);

  let problem;
  if ((problem = guard.checkUsername(username))) return back(problem, "username");
  if ((problem = guard.checkEmail(email))) return back(problem, "email");
  if ((problem = guard.checkPassword(password, username))) return back(problem, "password");
  if (typeof confirm === "string" && confirm !== password) return back("Those passwords don't match.", "confirm_password");

  const userId = uuidv4();
  try {
    const taken = await getQuery(
      "SELECT LOWER(username) = LOWER(?) AS u, LOWER(email) = LOWER(?) AS e FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 5",
      [username, email, username, email]
    );
    if (taken.some((r) => r.u)) return back("That username is taken. Try another one.", "username");
    if (taken.some((r) => r.e)) return back("That email already has an account. Sign in, or reset your password if you've forgotten it.", "email");

    const hashedPassword = await bcrypt.hash(password, 12);
    try {
      await runQuery(
        "INSERT INTO users (userId, username, displayname, password, email, points_balance, xp, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        // 1.99bg: starts at 0 (the 50,000 here was minted and farmable) - the welcome bonus vests (welcome.js)
        [userId, username, username, hashedPassword, email, 0, 0, "/public/img/avatar.png"]
      );
    } catch (e) {
      // two sign-ups for the same name at once: the UNIQUE index catches the second
      if (/UNIQUE/i.test(String(e && e.message))) return back("That username or email was just taken. Try another one.", "username");
      throw e;
    }
    registerLimit.hit(ip);
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

    // Signed straight in (same 90-day login as a normal sign-in).
    issueLogin(res, { userId, username, class: "pleb" });
    req.flash("success", `Welcome to PATV, ${username}! Check your email to verify your address.`);
    return res.redirect(next || `/u/${encodeURIComponent(username)}/wheel`);
  } catch (error) {
    console.error(`[auth] registration error: ${error && error.message}`);
    return back("Something went wrong creating your account. Please try again.");
  }
}

// Function to generate a unique validation link
function generateValidationToken() {
  return crypto.randomBytes(20).toString('hex');
}

// In case of username collision, generate a unique username.
async function generateUniqueUsername(baseUsername) {
  let username = baseUsername;
  let isUnique = false;
  let counter = 1;

  while (!isUnique) {
    // Check if the username already exists in the database
    const existingUser = await getQuery("SELECT xp, level FROM users WHERE username = ?", [username]);

    if (existingUser[0]) {
      // Username exists, append a number and check again
      username = `${baseUsername}${counter}`;
      counter++;
    } else {
      // Username is unique
      isUnique = true;
    }
  }

  return username; // Return the unique username
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

  try {
      await sgMail.send(msg);
      console.log('Verification email sent successfully');
  } catch (error) {
      console.error('Failed to send verification email', error);
  }
}


// Function to handle user login. Username (any case) or email; never logs the password.
async function loginUser(req, res) {
  const body = req.body || {};
  const ident = String(body.username == null ? "" : body.username).trim().slice(0, 254);
  const password = typeof body.password === "string" ? body.password : "";
  const next = guard.safeNext(body.next);
  const back = (msg, field) => backTo(req, res, "/login", next, msg, { username: ident, field });

  if (!guard.sameSite(req)) return res.status(403).send("Cross-site sign-in refused");
  if (!ident) return back("Enter your username or email.", "username");
  if (!password) return back("Enter your password.", "password");

  const ip = guard.clientIp(req);
  const who = ident.toLowerCase();
  const wait = Math.max(loginPairLimit.blocked(ip + "|" + who), loginNameLimit.blocked(who), loginIpLimit.blocked(ip));
  if (wait) return back(`Too many sign-in attempts. Try again in ${guard.waitText(wait)}, or reset your password.`);

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
      return back("That username and password don't match. Check caps lock, or reset your password.", "password");
    }
    loginPairLimit.reset(ip + "|" + who);
    await require("./staleaccounts").touch(user.userId, "sign-in");   // 1.99bm: an archived account comes back
    issueLogin(res, user);   // 90-day sliding login (middleware/loginCookie.js)
    return res.redirect(next || `/u/${encodeURIComponent(user.username)}/wheel`);
  } catch (err) {
    console.error("[auth] login error:", err && err.message);
    return back("Something went wrong signing you in. Please try again.");
  }
}

// Update username
async function updateUsername(req, res) {
  const username = String((req.body && req.body.username) || '').trim();
  const userId = req.user.userId;
  const editPage = `/u/${encodeURIComponent(req.user.username)}/edit`;
  if (!guard.sameSite(req)) return res.status(403).send('Forbidden');
  const problem = guard.checkUsername(username);
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
          await runQuery('UPDATE users SET username = ? WHERE userId = ?', [username, userId]);
          req.flash('success', 'Username changed.');
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
            return res.redirect(`/u/${username}/edit`);
        }
        if (user) {
            req.flash('error', 'Email already taken');
            return res.redirect(`/u/${username}/edit`);
        }
  
        const token = generateValidationToken();

        await updateUserWithToken(userId, token);
        await sendVerificationEmail(email, username, token);

        await runQuery('UPDATE users SET email = ?, isEmailVerified = 0 WHERE userId = ?', [email, userId]);
        req.flash('success', 'Verification email sent.');
        res.redirect(`/u/${username}/edit`);
      });
};

// Update password
async function updatePassword(req, res) {
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  const userId = req.user.userId;
  const username = req.user.username;
  const editPage = `/u/${encodeURIComponent(username)}/edit#password`;
  if (!guard.sameSite(req)) return res.status(403).send('Forbidden');
  const problem = guard.checkPassword(password, username);
  if (problem) {
    req.flash('error', problem);
    return res.redirect(editPage);
  }
  const hashedPassword = await bcrypt.hash(password, 12);
  await runQuery('UPDATE users SET password = ? WHERE userId = ?', [hashedPassword, userId]);
  // Sign out and back in with the new password. (This used to redirect to GET /logout, which
  // doesn't exist - logout is POST-only - so changing your password ended on a 404.)
  clearLogin(res);
  req.flash('success', 'Password changed. Sign in with your new password.');
  res.redirect('/login');
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
  res.redirect(`/u/${username}/edit`);
};

// Update twitch
async function updateTwitchId(req, res) {
  const { twitchId } = req.body;
  const userId = req.user.userId;
  const username = req.user.username;
  await runQuery('UPDATE users SET avatar = ? WHERE twitchId = ?', [twitchId, userId]);
  req.flash('success', 'Twitch changed.');
  res.redirect(`/u/${username}/edit`);
};

// Internal helper: complete the camfrog link.
// Handles three cases:
//   1. CF-prefixed auto account with this camfrog username → merge balance + delete it
//   2. Another non-CF account already claims this camfrog username → unlink it (no merge, it's a different user's account)
//   3. No existing account → just set the link
// Assumes ownership has been verified (via chat code).
async function completeCamfrogLink(userId, camfrogUsername) {
  const cfLower = camfrogUsername.toLowerCase().trim();
  // 1.99bm: an archived account on this name gets its balance back first, so the merge below carries it
  for (const r of await getQuery("SELECT userId FROM users WHERE LOWER(camfrogUsername) = LOWER(?) AND userId != ?", [cfLower, userId])) {
    await require("./staleaccounts").touch(r.userId, "camfrog link");
  }

  // Case 1: existing CF auto-account
  const autoAccounts = await getQuery(
    "SELECT userId, points_balance, xp, level, twitchBonus, twitchBonus_at, discordBonus, discordBonus_at, liked FROM users WHERE LOWER(camfrogUsername) = LOWER(?) AND userId != ? AND username LIKE 'CF%'",
    [cfLower, userId]
  );

  // Case 2: existing non-CF account that has this camfrog username linked
  const otherAccounts = await getQuery(
    "SELECT userId, username FROM users WHERE LOWER(camfrogUsername) = LOWER(?) AND userId != ? AND username NOT LIKE 'CF%'",
    [cfLower, userId]
  );

  let unlinkedFrom = null;
  if (otherAccounts.length > 0) {
    const other = otherAccounts[0];
    console.log(`[CF-RELINK] Unlinking camfrog "${cfLower}" from account ${other.username} (${other.userId})`);
    await runQuery('UPDATE users SET camfrogUsername = NULL WHERE userId = ?', [other.userId]);
    // the Camfrog achievements go with the Camfrog name (quietly: no second XP/PAT)
    const copied = await copyCamfrogBadges(other.userId, userId);
    if (copied) console.log(`[CF-RELINK] copied ${copied} Camfrog achievement(s) to ${userId}`);
    unlinkedFrom = other.username;
  }

  if (autoAccounts.length > 0) {
    const auto = autoAccounts[0];
    const me = await getQuery('SELECT points_balance, xp, level FROM users WHERE userId = ?', [userId]);
    const mergedBalance = (me[0]?.points_balance || 0) + (auto.points_balance || 0);
    const mergedXp = (me[0]?.xp || 0) + (auto.xp || 0);
    const mergedLevel = Math.max(me[0]?.level || 1, auto.level || 1);

    console.log(`[CF-MERGE] Merging auto account ${auto.userId} into ${userId}: +PAT ${auto.points_balance}, +XP ${auto.xp}`);
    // 1.99bs: the login is unique (users_camfrog_login) - free it on the auto account first
    for (const a of autoAccounts) await runQuery('UPDATE users SET camfrogUsername = NULL WHERE userId = ?', [a.userId]);

    await runQuery(
      `UPDATE users SET
        camfrogUsername = ?,
        points_balance = ?,
        xp = ?,
        level = ?,
        liked = COALESCE(liked, 0) + ?,
        twitchBonus = CASE WHEN twitchBonus = 1 OR ? = 1 THEN 1 ELSE 0 END,
        twitchBonus_at = COALESCE(twitchBonus_at, ?),
        discordBonus = CASE WHEN discordBonus = 1 OR ? = 1 THEN 1 ELSE 0 END,
        discordBonus_at = COALESCE(discordBonus_at, ?)
      WHERE userId = ?`,
      [cfLower, mergedBalance, mergedXp, mergedLevel, auto.liked || 0,
       auto.twitchBonus, auto.twitchBonus_at, auto.discordBonus, auto.discordBonus_at, userId]
    );

    await runQuery('UPDATE transactions SET userId = ? WHERE userId = ?', [userId, auto.userId]);
    // Everything else the auto account owned (badges, cosmetics, roles, spins, orders…) moves too.
    // Badges left behind used to be awarded AGAIN, with full XP + PAT, once the merged account was
    // active (the auto account had them from the quiet backfill).
    const moved = await moveUserRows(auto.userId, userId);
    console.log(`[CF-MERGE] moved from ${auto.userId}: ${JSON.stringify(moved)}`);
    await runQuery('DELETE FROM users WHERE userId = ?', [auto.userId]);

    await inbox.attachPendingSafe(userId, cfLower);   // notices Pepe sent this name before it had an account
    return { merged: true, addedBalance: auto.points_balance || 0, addedXp: auto.xp || 0, unlinkedFrom };
  } else {
    await runQuery('UPDATE users SET camfrogUsername = ? WHERE userId = ?', [cfLower, userId]);
    await inbox.attachPendingSafe(userId, cfLower);
    return { merged: false, unlinkedFrom };
  }
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
    await runQuery('UPDATE users SET camfrogUsername = ? WHERE userId = ?', [null, userId]);
    req.flash('success', 'Camfrog username unlinked.');
    return res.redirect(`/u/${username}/edit`);
  }

  try {
    // Check if the user is already linked to this same camfrog username — no-op
    const me = await getQuery('SELECT camfrogUsername FROM users WHERE userId = ?', [userId]);
    if (me[0]?.camfrogUsername && me[0].camfrogUsername.toLowerCase() === cfLower) {
      req.flash('success', 'Camfrog username already linked.');
      return res.redirect(`/u/${username}/edit`);
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
  } catch (err) {
    console.error('[CF-LINK] Initiate error:', err);
    req.flash('error', 'Failed to initiate Camfrog link.');
  }
  res.redirect(`/u/${username}/edit`);
};

// Step 2: Bot calls this when a user types !verify CODE in Camfrog chat.
// Body: { code, camfrogUsername (from chat author), password (bot token) }
// Verifies the chat author's username matches the pending link, then completes it.
async function verifyCamfrogLink(req, res) {
  const { code, camfrogUsername, password } = req.body;
  if (password !== process.env.TWITCH_BOT_TOKEN) {
    return res.status(403).json({ error: 'Invalid bot token' });
  }
  if (!code || !camfrogUsername) {
    return res.status(400).json({ error: 'Missing code or camfrogUsername' });
  }

  try {
    const pending = await getQuery(
      'SELECT userId, camfrogUsername, expires_at FROM pending_camfrog_links WHERE code = ?',
      [code.toUpperCase()]
    );
    if (pending.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired verification code' });
    }

    const entry = pending[0];
    if (new Date(entry.expires_at) < new Date()) {
      await runQuery('DELETE FROM pending_camfrog_links WHERE code = ?', [code.toUpperCase()]);
      return res.status(410).json({ error: 'Verification code expired' });
    }

    // Critical: confirm the chat author's username matches the username they claimed
    if (entry.camfrogUsername.toLowerCase() !== camfrogUsername.toLowerCase()) {
      return res.status(403).json({
        error: `Code belongs to camfrog user "${entry.camfrogUsername}", not "${camfrogUsername}". Each user must verify their own link.`
      });
    }

    // Complete the link with merge logic
    const result = await completeCamfrogLink(entry.userId, entry.camfrogUsername);

    // Clear the pending entry
    await runQuery('DELETE FROM pending_camfrog_links WHERE code = ?', [code.toUpperCase()]);

    // Get the website username for the response
    const userRow = await getQuery('SELECT username FROM users WHERE userId = ?', [entry.userId]);

    res.json({
      success: true,
      websiteUsername: userRow[0]?.username,
      camfrogUsername: entry.camfrogUsername,
      merged: result.merged,
      addedBalance: result.addedBalance || 0,
      addedXp: result.addedXp || 0,
      unlinkedFrom: result.unlinkedFrom || null,
    });
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
const _levelLocks = new Map();
function _withLevelLock(userId, fn) {
  const prev = _levelLocks.get(userId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  _levelLocks.set(userId, tail);
  tail.then(() => { if (_levelLocks.get(userId) === tail) _levelLocks.delete(userId); });
  return run;
}
function updateLevel(userId, additionalXp) {
  return _withLevelLock(userId, () => _updateLevelLocked(userId, additionalXp));
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
function adminAdjustXp(userId, { mode, amount }, { apply = false, onApplied = null } = {}) {
  const go = async () => {
    const row = (await getQuery("SELECT xp, level FROM users WHERE userId = ?", [userId]))[0];
    if (!row) throw Object.assign(new Error("No such account."), { status: 404 });
    const plan = _xpPlan(row, mode, amount);
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
    if (await funding.fundPayout(userId, m.amount, "levelup", `Level ${m.level} milestone`)) {
      total += m.amount;
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
    console.error("User not found");
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
      if (await funding.fundPayout(userId, LEVELUP_BASE_REWARD, "levelup", `Level-up reward (Lv ${level})`)) {
        totalBonusPoints += LEVELUP_BASE_REWARD;
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
async function awardBadge(userId, badgeId) {
  try {
    // Check if the badge exists
    const badgeDetails = await getQuery("SELECT points FROM badges WHERE badgeId = ?", [badgeId]);
    if (badgeDetails.length === 0) {
      throw new Error('Badge not found'); // Throw an error if the badge doesn't exist
    }

    // Check if the badge has already been awarded
    const existingBadge = await getQuery("SELECT * FROM user_badges WHERE userId = ? AND badgeId = ?", [userId, badgeId]);
    if (existingBadge.length > 0) {
      console.log(`User ${userId} already has badge ${badgeId}. No badge awarded.`);
      throw new Error('Badge already awarded'); // Throw an error if the badge has already been awarded
    }

    await runQuery("BEGIN TRANSACTION"); // Begin transaction

    const points = badgeDetails[0].points;

    // Update the user's points
    updateLevel(userId, points);

    // Insert the badge award into the user_badges table
    const sqlInsertBadge = "INSERT INTO user_badges (userId, badgeId) VALUES (?, ?)";
    await runQuery(sqlInsertBadge, [userId, badgeId]);

    await runQuery("COMMIT"); // Commit the transaction

    console.log(`Badge ${badgeId} awarded to user ${userId} with ${points} XP added.`);
    return { success: true, message: `Badge ${badgeId} awarded to user ${userId}.` };
  } catch (error) {
    await runQuery("ROLLBACK"); // Rollback in case of error
    console.error(`Error awarding badge: ${error.message}`);
    throw error; // Rethrow the error so the calling function can handle it
  }
};

// Function to Award Bonus PAT

async function awardBonus(userId, type, amount) {
  if (!userId || !amount || !type) {
    console.error("Missing required fields");
  }

  try {
    // 1.63: bonuses are paid OUT of a vault (connect bonuses: "connect_bonus"; anything else:
    // "platform_rewards") and skipped when it can't cover them - never minted.
    const flow = /connect/i.test(String(type)) ? "connect_bonus" : "platform_rewards";
    if (!(await funding.takeFunds(flow, amount, userId, type))) return;
    // Start a transaction
    const transactionId = uuidv4();
    const bonusId = uuidv4();
    await runQuery("BEGIN TRANSACTION");

    // Add points to the winner's points balance
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, userId]);

    // Insert into bonus_winners table   
    await runQuery(
      "INSERT INTO bonus_winners (bonusId, type, userId, transactionId, amount) VALUES (?, ?, ?, ?, ?)",
      [bonusId, type, userId, transactionId, amount]
    );

    // Log the transaction
    await runQuery(
      "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
      [transactionId, userId, "bonus win", amount]
    );

    // Commit the transaction
    await runQuery("COMMIT");
    console.log(`${amount} PAT bonus points awarded to ${userId} successfully.`)
    return  { success: true, message: `${amount} PAT bonus points awarded to ${userId} successfully.` };
  } catch (error) {
    // Rollback in case of error
    await runQuery("ROLLBACK");
    console.error("Failed to process bonus winner:", error);
    throw error; // Rethrow the error so the calling function can handle it
  }
};

module.exports = {
  registerUser,
  loginUser,
  updateUsername,
  updateEmail,
  updatePassword,
  updateDisplayname,
  updateAvatar,
  updateDiscordId,
  updateTwitchId,
  updateCamfrogUsername,
  verifyCamfrogLink,
  awardBadge,
  xpForNextLevel,
  updateLevel,
  adminAdjustXp,
  checkXpAdjust,
  totalXpOf,
  levelOfTotal,
  levelReward,
  milestoneReward,
  LEVELUP_BASE_REWARD,
  LEVELUP_MILESTONE_UNIT,
  awardBonus,
  generateUniqueUsername
};