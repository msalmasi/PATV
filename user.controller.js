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
    const sqlCheckUser = "SELECT * FROM users WHERE username = ? OR email = ?";
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
  awardBadge,
  xpForNextLevel,
  updateLevel,
  awardBonus,
  generateUniqueUsername
};