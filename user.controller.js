// user.controller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose()
const { v4: uuidv4 } = require('uuid');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const { createTables, runQuery, getQuery } = require('./dbUtils');
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

// Function to handle user registration
async function registerUser(req, res) {
  const userId = uuidv4();
  const { username, password, email } = req.body;

  if (!/\S+@\S+\.\S+/.test(email)) {
    req.flash('error', 'Invalid email address.');
    return res.redirect('/register');
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    const sqlCheckUser = "SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)";
    const user = await getQuery(sqlCheckUser, [username, email]);

    if (user.length > 0) {
      req.flash('error', 'Username or email already taken');
      return res.redirect('/register');
    }

    const sqlInsertUser = 'INSERT INTO users (userId, username, displayname, password, email, points_balance, xp, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    await runQuery(sqlInsertUser, [userId, username, username, hashedPassword, email, 50000, 0, '/public/img/avatar.png']);
    
    const token = generateValidationToken();
    updateUserWithToken(userId, token);
    sendVerificationEmail(email, username, token);

    // Award "New User" badge
    const newUserBadgeId = 'fresh_meat'; // Ensure this ID matches the one in your badges table
    await awardBadge(userId, newUserBadgeId);

    req.flash('success', 'Successfully registered! Please login.');
    res.redirect('/login');
  } catch (error) {
    console.error(`Server error during registration: ${error}`);
    req.flash('error', 'Server error');
    res.redirect('/register');
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
  const link = `http://publicaccess.tv/verify-email?token=${token}`;
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


// Function to handle user login
function loginUser(req, res) {
  const { username, password } = req.body;

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
      if (err) {
          console.error(err.message);
          req.flash('error', 'Error logging in user');
          return res.redirect('/login');
          return;
      }
      if (!user || !(await bcrypt.compare(password, user.password))) {
        req.flash('error', 'Authentication failed');
        return res.redirect('/login');
      }
      // const token = jwt.sign({ userId: user.userId }, process.env.SECRET_KEY, { expiresIn: '1h' });
      // res.json({ token: token });
          const token = jwt.sign({ userId: user.userId, username: user.username, class: user.class }, process.env.SECRET_KEY, { expiresIn: '168h' });
          res.cookie('jwt', token, { httpOnly: true, secure: true, sameSite: 'Lax' });
          res.redirect(`/u/${username}/wheel`);  // Redirect to a secure page
  });
};

// Update username
async function updateUsername(req, res) {
  const { username } = req.body;
  const userId = req.user.userId;
        // Check if the username or email is already taken
        db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
          if (err) {
              console.error(err.message);
              req.flash('error', 'Error processing request');
              return res.redirect(`/u/${username}/profile/edit`);
          }
          if (user) {
              req.flash('error', 'Username already taken');
              return res.redirect(`/u/${username}/profile/edit`);
          }
          await runQuery('UPDATE users SET username = ? WHERE userId = ?', [username, userId]);
          req.flash('success', 'Username changed.');
          res.clearCookie("jwt");
          res.redirect(`/login`);
        });
};

// Update displayname
async function updateDisplayname(req, res) {
  const { displayname } = req.body;
  const userId = req.user.userId;
  const username = req.user.username;
  await runQuery('UPDATE users SET displayname = ? WHERE userId = ?', [displayname, userId]);
  req.flash('success', 'Displayname changed.');
  res.redirect(`/u/${username}/profile/edit`);
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
            return res.redirect(`/u/${username}/profile/edit`);
        }
        if (user) {
            req.flash('error', 'Email already taken');
            return res.redirect(`/u/${username}/profile/edit`);
        }
  
        const token = generateValidationToken();

        await updateUserWithToken(userId, token);
        await sendVerificationEmail(email, username, token);

        await runQuery('UPDATE users SET email = ?, isEmailVerified = 0 WHERE userId = ?', [email, userId]);
        req.flash('success', 'Verification email sent.');
        res.redirect(`/u/${username}/profile/edit`);
      });
};

// Update password
async function updatePassword(req, res) {
  const { password } = req.body;
  const userId = req.user.userId;
  const username = req.user.username;
  const hashedPassword = await bcrypt.hash(password, 12);
  await runQuery('UPDATE users SET password = ? WHERE userId = ?', [hashedPassword, userId]);
  req.flash('success', 'Password changed.');
  res.redirect(`/logout`);
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
  res.redirect(`/u/${username}/profile/edit`);
};

// Update twitch
async function updateTwitchId(req, res) {
  const { twitchId } = req.body;
  const userId = req.user.userId;
  const username = req.user.username;
  await runQuery('UPDATE users SET avatar = ? WHERE twitchId = ?', [twitchId, userId]);
  req.flash('success', 'Twitch changed.');
  res.redirect(`/u/${username}/profile/edit`);
};

// Internal helper: complete the camfrog link.
// Handles three cases:
//   1. CF-prefixed auto account with this camfrog username → merge balance + delete it
//   2. Another non-CF account already claims this camfrog username → unlink it (no merge, it's a different user's account)
//   3. No existing account → just set the link
// Assumes ownership has been verified (via chat code).
async function completeCamfrogLink(userId, camfrogUsername) {
  const cfLower = camfrogUsername.toLowerCase().trim();

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
    unlinkedFrom = other.username;
  }

  if (autoAccounts.length > 0) {
    const auto = autoAccounts[0];
    const me = await getQuery('SELECT points_balance, xp, level FROM users WHERE userId = ?', [userId]);
    const mergedBalance = (me[0]?.points_balance || 0) + (auto.points_balance || 0);
    const mergedXp = (me[0]?.xp || 0) + (auto.xp || 0);
    const mergedLevel = Math.max(me[0]?.level || 1, auto.level || 1);

    console.log(`[CF-MERGE] Merging auto account ${auto.userId} into ${userId}: +PAT ${auto.points_balance}, +XP ${auto.xp}`);

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
    await runQuery('DELETE FROM users WHERE userId = ?', [auto.userId]);

    return { merged: true, addedBalance: auto.points_balance || 0, addedXp: auto.xp || 0, unlinkedFrom };
  } else {
    await runQuery('UPDATE users SET camfrogUsername = ? WHERE userId = ?', [cfLower, userId]);
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
    return res.redirect(`/u/${username}/profile/edit`);
  }

  try {
    // Check if the user is already linked to this same camfrog username — no-op
    const me = await getQuery('SELECT camfrogUsername FROM users WHERE userId = ?', [userId]);
    if (me[0]?.camfrogUsername && me[0].camfrogUsername.toLowerCase() === cfLower) {
      req.flash('success', 'Camfrog username already linked.');
      return res.redirect(`/u/${username}/profile/edit`);
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
      req.flash('error', `Warning: "${camfrogUsername}" is currently linked to account "${claimed[0].username}". Verifying with the code below will unlink it from that account and move it to yours. Type in the Camfrog room: !verify ${code} (expires in 15 minutes)`);
    } else {
      req.flash('success', `To verify ownership of "${camfrogUsername}", type this in the Camfrog room: !verify ${code} (expires in 15 minutes)`);
    }
  } catch (err) {
    console.error('[CF-LINK] Initiate error:', err);
    req.flash('error', 'Failed to initiate Camfrog link.');
  }
  res.redirect(`/u/${username}/profile/edit`);
};

// Step 2: Bot calls this when a user types !verify CODE in Camfrog chat.
// Body: { code, camfrogUsername (from chat author), password (bot token) }
// Verifies the chat author's username matches the pending link, then completes it.
async function verifyCamfrogLink(req, res) {
  const { code, camfrogUsername, password } = req.body;
  if (password !== process.env.BOT_TOKEN) {
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
async function updateLevel(userId, additionalXp) {
  const userDetails = await getQuery("SELECT xp, level FROM users WHERE userId = ?", [userId]);
  if (userDetails.length === 0) {
    console.error("User not found");
    return null;
  }

  let { xp, level } = userDetails[0];
  let originalLevel = level;
  xp += additionalXp;

  let totalBonusPoints = 0;
  let levelsGained = 0;

  while (xp >= xpForNextLevel(level)) {
    xp -= xpForNextLevel(level);
    level++;
    levelsGained++;
    const pointsReward = 10 * xpForNextLevel(level - 1);
    totalBonusPoints += pointsReward;
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [pointsReward, userId]);
  }

  await runQuery("UPDATE users SET xp = ?, level = ? WHERE userId = ?", [xp, level, userId]);
  console.log(`User ${userId} is now level ${level} with ${xp} XP.`);

  return {
    leveledUp: levelsGained > 0,
    newLevel: level,
    levelsGained: levelsGained,
    bonusPoints: totalBonusPoints
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
  awardBonus,
  generateUniqueUsername
};