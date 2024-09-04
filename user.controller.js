// user.controller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose()
const { v4: uuidv4 } = require('uuid');

// Connect to SQLite database
const db = new sqlite3.Database('./myapp.db', (err) => {
  if (err) {
      console.error('Error opening database ' + err.message);
  } else {
      console.log('Database connected.');
  }
});

// Function to handle user registration
function registerUser(req, res) {
  const userId = uuidv4();
  const { username, password, email } = req.body;

  try {
    const hashedPassword = bcrypt.hash(password, 12);
    // Check if the username is already taken
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
      if (err) {
          console.error(err.message);
          res.status(500).send('Error logging in');
          return;
      }
      if (user) {
          return res.status(401).send('Username already taken');
      }
    // Store the hashedPassword in the database
    db.run('INSERT INTO users (userId, username, password, email) VALUES (?, ?, ?, ?)', [userId, username, hashedPassword, email], function(err) {
      if (err) {
        res.status(500).send('Error registering new user');
        return;
      }
      res.status(201).send('User registered successfully');
    });
    });
  } catch (error) {
    res.status(500).send('Server error');
  }
};

// Function to handle user login
function loginUser(req, res) {
  const { username, password } = req.body;

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
      if (err) {
          console.error(err.message);
          res.status(500).send('Error logging in');
          return;
      }
      if (!user || !(await bcrypt.compare(password, user.password))) {
          return res.status(401).send('Authentication failed');
      }
      // const token = jwt.sign({ userId: user.id }, process.env.SECRET_KEY, { expiresIn: '1h' });
      // res.json({ token: token });
          const token = jwt.sign({ userId: user.userId }, process.env.SECRET_KEY, { expiresIn: '1h' });
          res.cookie('jwt', token, { httpOnly: true, secure: true, sameSite: 'Strict' });
          res.redirect(`/u/${username}/wheel`);  // Redirect to a secure page
  });
};

module.exports = {
  registerUser,
  loginUser
};