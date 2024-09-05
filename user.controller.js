// user.controller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose()
const { v4: uuidv4 } = require('uuid');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const { createTables, runQuery, getQuery } = require('./dbUtils');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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
          db.run('INSERT INTO users (userId, username, password, email, points_balance) VALUES (?, ?, ?, ?, ?)', 
                  [userId, username, hashedPassword, email, 500000], function(err) {
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
  const link = `http://localhost:3000/verify-email?token=${token}`;
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
      // const token = jwt.sign({ userId: user.id }, process.env.SECRET_KEY, { expiresIn: '1h' });
      // res.json({ token: token });
          const token = jwt.sign({ userId: user.userId, username: user.username, class: user.class }, process.env.SECRET_KEY, { expiresIn: '1h' });
          res.cookie('jwt', token, { httpOnly: true, secure: true, sameSite: 'Strict' });
          res.redirect(`/u/${username}/wheel`);  // Redirect to a secure page
  });
};

module.exports = {
  registerUser,
  loginUser
};