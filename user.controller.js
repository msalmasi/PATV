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

  // Validate email format (basic check)
  if (!/\S+@\S+\.\S+/.test(email)) {
      req.flash('error', 'Invalid email address.');
      return res.redirect('/register');
  }

  try {
      const hashedPassword = await bcrypt.hash(password, 12);

      // Check if the username or email is already taken
      db.get(`SELECT * FROM users WHERE username = ? OR email = ?`, [username, email], async (err, user) => {
          if (err) {
              console.error(err.message);
              req.flash('error', 'Error processing request');
              return res.redirect('/register');
          }
          if (user) {
              req.flash('error', 'Username or email already taken');
              return res.redirect('/register');
          }

          // Store the hashedPassword in the database with starting points.
          db.run('INSERT INTO users (userId, username, displayname, password, email, points_balance, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)', 
                  [userId, username, username, hashedPassword, email, 500000, '/public/img/avatar.png'], function(err) {
              if (err) {
                  console.error(err.message);
                  req.flash('error', 'Error registering new user');
                  return res.redirect('/register');
              }
              const token = generateValidationToken();
              updateUserWithToken(userId, token);
              sendVerificationEmail(email, username, token);
              req.flash('success', 'Successfully registered! Please login.');
              res.redirect('/login');
          });
      });
  } catch (error) {
      console.error(error);
      req.flash('error', 'Server error');
      res.redirect('/register');
  }
}

// Function to generate a unique validation link
function generateValidationToken() {
  return crypto.randomBytes(20).toString('hex');
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
          const token = jwt.sign({ userId: user.userId, username: user.username, class: user.class }, process.env.SECRET_KEY, { expiresIn: '1h' });
          res.cookie('jwt', token, { httpOnly: true, secure: false, sameSite: 'Lax' });
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
          res.redirect(`/u/${username}/profile/edit`);
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

module.exports = {
  registerUser,
  loginUser,
  updateUsername,
  updateEmail,
  updatePassword,
  updateDisplayname,
  updateAvatar,
  updateDiscordId,
  updateTwitchId
};