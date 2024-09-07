require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
const fs = require('fs');
const path = require('path');
const port = 3000;
const sqlite3 = require('sqlite3').verbose()
const { v4: uuidv4 } = require('uuid');
const {fileURLToPath} = require('url')
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const morgan = require('morgan');
const { registerUser, loginUser, updateUsername, updateEmail, updatePassword, updateDisplayname, updateAvatar, updateDiscordId, updateTwitchId } = require('./user.controller');
const { createTables, runQuery, getQuery } = require('./dbUtils');
const authenticateToken = require('./middleware/authenticateToken');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const flash = require('connect-flash');
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');
const multer = require('multer');
const sharp = require('sharp');
const AWS = require('aws-sdk');
const upload = multer({ dest: 'uploads/' });

// AWS S3 configuration
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
  });

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

let MemoryStore = session.MemoryStore;

// Cookie Parser Middleware
app.use(cookieParser(process.env.APP_SESSION_SECRET)); 

app.use(session({
    secret: process.env.APP_SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    cookie: { secure: 'auto' }  // This should be set based on your environment.
}));

app.use(flash());

// // Sessuib
// app.use(session({
//     secret: process.env.APP_SESSION_SECRET,
//     resave: true,  // Forces the session to be saved back to the session store, even if the session was never modified
//     saveUninitialized: false,  // Don't create session until something stored
//     cookie: { secure: 'auto' }  // Use 'auto' to secure cookies only if the connection is secure
// }));

// Set the view engine to ejs
app.set('view engine', 'ejs');

// Set the views directory
app.set('views', './views');

// Set morgan logging
// app.use(morgan("combined"));

// Custom middleware test
app.use((req, res, next) => {
    console.log("Request method: ", req.params);
    next();
});

// Helper Middleware for Auth
function addUser(req, res, next) {
    const token = req.cookies.jwt;
    if (token) {
        jwt.verify(token, process.env.SECRET_KEY, (err, decoded) => {
            if (!err) {
                req.user = decoded; // Attach user details to request
            }
            else {
                req.user = null;
            }
        });
    }
    next(); // Proceed regardless of token validity
}

// Connect to SQLite database
const db = new sqlite3.Database('./myapp.db', (err) => {
    if (err) {
        console.error('Error opening database ' + err.message);
    } else {
        console.log('Database connected.');
        createTables();
    }
});

module.exports = db;

app.use(cors());
app.use(express.json()); // Middleware to parse JSON bodies
app.use(express.urlencoded({ extended: true }));

let clients = []; // Keep track of connected clients for SSE

// Serve static files from the public directory
app.use('/public', express.static('public'));

// Homepage
app.get('/', addUser, async (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    try {
        res.render('home', { user: username });
        // Proceed with fetching user data and generating wheel
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: error });
    }
});

// Admin Panel Endpoint
app.get('/admin/panel', addUser, (req, res) => {
    console.log(req.user);
    const userType = req.user ? req.user.class : null;
    const username = req.user ? req.user.username : null;
    if (userType === 'Admin' || userType === 'Staff') {
        let errorMessages = req.flash('error');
        let successMessages = req.flash('success');
        res.render('adminPanel', { 
            user: username, 
            errors: errorMessages,
            success: successMessages
        });
    } else {
        req.flash('error', "Access denied. You must be an admin or staff to access this page.");
        return res.redirect('/login');
    }
});

// Just for fun
app.get('/friendo', (req, res) => {

    res.render("friendo", {title: "friendo"})
  
})

// Example route with authentication middleware
app.get('/protected', authenticateToken, (req, res) => {
    res.json({ message: 'Protected route accessed successfully.' });
});

app.get('/register', addUser, async (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    let errorMessages = req.flash('error');
    let successMessages = req.flash('success');
    res.render('register', { 
        user: username, 
        errors: errorMessages,
        success: successMessages
    });
});

app.get('/login', (req, res) => {
    // Retrieve flash messages and pass them to the EJS template
    let errorMessages = req.flash('error');
    let successMessages = req.flash('success');
    res.render('login', {
        errors: errorMessages,
        success: successMessages
    });
});

// HTTP GET endpoint for verifying endpoint
app.get('/verify-email', async (req, res) => {
    const { token } = req.query;
    const sql = `SELECT userId, tokenExpires FROM users WHERE emailVerificationToken = ?`;

    try {
        const results = await getQuery(sql, [token]);
        if (!results || results.length === 0) {
            req.flash('error', 'Invalid or expired token');
            return res.redirect('/login');
        }

        const result = results[0];
        if (new Date(result.tokenExpires) < new Date()) {
            req.flash('error', 'Token has expired');
            return res.redirect('/login');
        }

        const updateSql = `UPDATE users SET isEmailVerified = 1, emailVerificationToken = NULL, tokenExpires = NULL WHERE userId = ?`;
        const updateResult = await runQuery(updateSql, [result.userId]);
        if (updateResult.changes > 0) {
            req.flash('success', 'Email verified successfully!');
        } else {
            req.flash('error', 'No changes made to the database.');
        }
        res.redirect('/login');
    } catch (error) {
        console.error('Failed to verify email', error);
        req.flash('error', 'Server error');
        res.redirect('/login');
    }
});

// HTTP GET endpoint to retrieve the last result.
app.get('/api/g/wheel/last-result', async (req, res) => {
    const sql = `
        SELECT userId, result
        FROM wheel_spins
        WHERE type = 'public'
        ORDER BY timestamp DESC
        LIMIT 1
    `;

    try {
        const lastResult = await getQuery(sql);
        if (!lastResult) {
            return res.status(404).send("No public spin results found.");
        }

        // Fetch username based on userId
        const userSql = `SELECT displayname FROM users WHERE userId = ?`;
        const user = await getQuery(userSql, [lastResult[0].userId]);
        console.log(user[0]);

        if (lastResult.result === "PENDING") {
            res.render('nowSpinning', { username: user[0].displayname });
        } else {
            res.render('lastSpinner', { username: user[0].displayname });
        }
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).send("Failed to fetch the last result.");
    }
});

// HTTP POST endpoint to reset password
app.post('/reset-password/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const { password, confirm_password } = req.body;

        if (password !== confirm_password) {
            req.flash('error', 'Passwords do not match.');
            return res.redirect('back');
        }

        const user = await db.get('SELECT * FROM users WHERE resetPasswordToken = ? AND resetPasswordExpires > ?', [token, Date.now()]);
        if (!user) {
            req.flash('error', 'Password reset token is invalid or has expired.');
            return res.redirect('back');
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        await db.run('UPDATE users SET password = ?, resetPasswordToken = NULL, resetPasswordExpires = NULL WHERE resetPasswordToken = ?', [hashedPassword, token]);

        req.flash('success', 'Success! Your password has been changed.');
        res.redirect('/login');
    } catch (error) {
        console.error('Reset Password Error:', error);
        req.flash('error', 'Error resetting password.');
        res.redirect('back');
    }
});

// HTTP POST endpoint to send a password reset link
app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    const token = crypto.randomBytes(20).toString('hex'); // Generate a token
    const expires = new Date(Date.now() + 3600000); // Token expires in 1 hour

    try {
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user) {
            req.flash('error', 'No account with that email address exists.');
            return res.redirect('/forgot-password');
        }

        // Store the token and expiration time in the database
        await db.run('UPDATE users SET resetPasswordToken = ?, resetPasswordExpires = ? WHERE email = ?', [token, expires, email]);

        // Send email with the reset link
        const resetUrl = `http://${req.headers.host}/reset-password/${token}`;
        const msg = {
            to: email,
            from: 'no-reply@publicaccess.tv',
            subject: 'Password Reset',
            text: `You are receiving this because you (or someone else) have requested the reset of the password for your account.\n\n
                   Please click on the following link, or paste this into your browser to complete the process:\n\n
                   ${resetUrl} \n\n
                   If you did not request this, please ignore this email and your password will remain unchanged.\n`
        };

        await sgMail.send(msg);
        req.flash('success', 'An e-mail has been sent to ' + email + ' with further instructions.');
        res.redirect('/forgot-password');
    } catch (error) {
        console.error('Forgot Password Error:', error);
        req.flash('error', 'Error resetting password.');
        res.redirect('/forgot-password');
    }
});

app.get('/forgot-password', (req, res) => {
    // Retrieve flash messages and pass them to the EJS template
    let errorMessages = req.flash('error');
    let successMessages = req.flash('success');
    res.render('forgotPassword', {
        errors: errorMessages,
        success: successMessages
    });
});

app.get('/info', addUser, (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    // Retrieve flash messages and pass them to the EJS template
    let errorMessages = req.flash('error');
    let successMessages = req.flash('success');
    res.render('info', {
        user: username,
        errors: errorMessages,
        success: successMessages
    });
});

app.get('/shop', addUser, (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    // Retrieve flash messages and pass them to the EJS template
    let errorMessages = req.flash('error');
    let successMessages = req.flash('success');
    res.render('shop', {
        user: username,
        errors: errorMessages,
        success: successMessages
    });
});

app.get('/reset-password/:token', async (req, res) => {
    const { token } = req.params;
    let errorMessages = req.flash('error');
    let successMessages = req.flash('success');
    // Optionally, validate the token before rendering the reset form
    try {
        const user = await db.get('SELECT * FROM users WHERE resetPasswordToken = ? AND resetPasswordExpires > ?', [token, new Date()]);
        if (!user) {
            req.flash('error', 'Password reset token is invalid or has expired.');
            return res.redirect('/forgot-password');
        }
        res.render('resetPassword', { 
            token: token,
            errors: errorMessages,
            success: successMessages 
        });
    } catch (error) {
        req.flash('error', 'Error accessing reset form.');
        res.redirect('/forgot-password');
    }
});

// HTTP GET endpoint to retrieve the leaderboards.
app.get('/rankings', addUser, async (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    
    const sql = `
        SELECT username, points_balance, displayname
        FROM users
        ORDER BY points_balance DESC
        LIMIT 100
    `;

    try {
        const users = await getQuery(sql);  // Adjust getQuery to handle multiple rows if needed
        res.render('leaderboard', { user: username, users });
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).send("Failed to fetch rankings.");
    }
});

// HTTP POST endpoint for registering a new user.
app.post('/register', registerUser);

// HTTP POST endpoint for logging in. 
app.post('/login', loginUser);

// HTTP POST endpoint for logging out.
app.post('/logout', (req, res) => {
    res.clearCookie('jwt');
    res.redirect('/');
});

// Get user profile
app.get('/u/:username/profile', addUser, async (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    const usernameProfile = req.params.username;  // Fallback to null if no user in session
    const sql = 'SELECT username, displayname, class, avatar, email, points_balance FROM users WHERE username = ?';

    try {
        const results = await getQuery(sql, [usernameProfile]);
        if (results.length > 0) {
            const user = results[0]; // Extract user data
            res.render('profile', { // Render profile.ejs with user data
                username: username,
                usernameProfile: user.username,
                displayname: user.displayname,
                classh: user.class,
                avatar: user.avatar,
                email: user.email,
                points_balance: user.points_balance
            });
        } else {
            res.status(404).send("User not found.");
        }
    } catch (error) {
        console.error("Failed to retrieve user data:", error);
        res.status(500).send("Internal Server Error.");
    }
});

// Get user profile
app.get('/u/:username/tip', addUser, async (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    const usernameProfile = req.params.username;  // Fallback to null if no user in session
    const sql = 'SELECT username, displayname, class, avatar, email, points_balance FROM users WHERE username = ?';

    try {
        const results = await getQuery(sql, [usernameProfile]);
        if (results.length > 0) {
            const user = results[0]; // Extract user data
            res.render('tip', { // Render profile.ejs with user data
                username: username,
                usernameProfile: user.username,
                displayname: user.displayname,
                classh: user.class,
                avatar: user.avatar,
                email: user.email,
                points_balance: user.points_balance
            });
        } else {
            res.status(404).send("User not found.");
        }
    } catch (error) {
        console.error("Failed to retrieve user data:", error);
        res.status(500).send("Internal Server Error.");
    }
});

// Tip another user
app.post('/u/:username/tip', authenticateToken, addUser, async (req, res) => {
    const { amount } = req.body;
    const senderUsername = req.user ? req.user.username : null;  // Logged in user's username
    const recipientUsername = req.params.username;

    if (!senderUsername) {
        return res.status(401).send('Authentication required');
    }

    if (senderUsername === recipientUsername) {
        return res.status(400).send('Cannot tip oneself');
    }

    try {
        // Check both users exist and fetch their current balances
        const users = await getQuery('SELECT username, userId, points_balance FROM users WHERE username IN (?, ?)', [senderUsername, recipientUsername]);
        if (users.length !== 2) {
            return res.status(404).send('One or both users not found');
        }

        const sender = users.find(user => user.username === senderUsername);
        const recipient = users.find(user => user.username === recipientUsername);

        if (sender.points_balance < amount) {
            return res.status(400).send('Insufficient balance');
        }

        // Deduct amount from sender's balance
        await runQuery('UPDATE users SET points_balance = points_balance - ? WHERE userId = ?', [amount, sender.userId]);

        // Add amount to recipient's balance 
        await runQuery('UPDATE users SET points_balance = points_balance + ? WHERE userId = ?', [amount, recipient.userId]);

        // Log transaction for sender
        const transactionIdSender = uuidv4();
        await runQuery('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)', [transactionIdSender, sender.userId, 'tip sent', -amount]);

        // Log transaction for receiver
        const transactionIdReceiver = uuidv4();
        await runQuery('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)', [transactionIdReceiver, recipient.userId, 'tip received', amount]);
        console.log('Tip sent successfully.')
        res.json({ message: "Tip sent successfully." });
    } catch (error) {
        console.error('Failed to process tip:', error);
        res.status(500).send('Failed to process tip');
    }
});

// Get the user avatar
app.get('/api/u/:username/avatar', addUser, async (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    const userId = req.user ? req.user.userId : null;  // Fallback to null if no user in session
    const sql = 'SELECT avatar FROM users WHERE userId = ?';
    try {
        const user = await getQuery(sql, [userId]);
        if (user) {
            res.json({ avatar: user[0].avatar });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (error) {
        console.error("Failed to retrieve avatar:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get user profile editor
app.get('/u/:username/profile/edit', authenticateToken, addUser, async (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    const usernameProfile = req.params.username;  // Fallback to null if no user in session
    const sql = 'SELECT username, displayname, avatar, email, points_balance FROM users WHERE username = ?';

    try {
        if (username == usernameProfile) {
            const results = await getQuery(sql, [usernameProfile]);
            if (results.length > 0) {
                const user = results[0]; // Extract user data
                let errorMessages = req.flash('error');
                let successMessages = req.flash('success');
                res.render('editProfile', { // Render profile.ejs with user data
                    username: user.username,
                    displayname: user.displayname,
                    avatar: user.avatar,
                    email: user.email,
                    points_balance: user.points_balance, 
                    errors: errorMessages,
                    success: successMessages
                });
            } else {
                res.status(404).send("User not found.");
            }
        } else {
                res.redirect(`/u/${username}/profile/edit`);
        }
    } catch (error) {
        console.error("Failed to retrieve user data:", error);
        res.status(500).send("Internal Server Error.");
    }
});

// Fetch user profile
app.get('/api/u/:username/profile', async (req, res) => {
    const username = req.params.username;
    const sql = 'SELECT username, class, displayname, avatar, points_balance FROM users WHERE username = ?';
    
    getQuery(sql, [username])
        .then(results => {
            if (results.length > 0) {
                res.json(results[0]);
            } else {
                res.status(404).send("User not found.");
            }
        })
        .catch(error => {
            console.error("Failed to retrieve user data:", error);
            res.status(500).send("Failed to retrieve user data.");
        });
});

// Update user profile
// app.post('/api/u/:username/profile', addUser, async (req, res) => {
//     const { username, displayname, avatar, email, password } = req.body;
//     const userId = req.user ? req.user.userId : null;  // Fallback to null if no user in session

//     try {
//         // Handle password update separately if provided
//         if (password) {
//             const hashedPassword = await bcrypt.hash(password, 10);
//             await runQuery('UPDATE users SET password = ? WHERE userId = ?', [hashedPassword, userId]);
//         }

//         const updateSql = 'UPDATE users SET username = ?, displayname = ?, avatar = ?, email = ? WHERE userId = ?';
//         const result = await runQuery(updateSql, [username, displayname, avatar, email, userId]);
        
//         if (result.changes > 0) {
//             res.send("Profile updated successfully.");
//         } else {
//             res.status(404).send("No updates made. User not found.");
//         }
//     } catch (error) {
//         console.error("Failed to update profile:", error);
//         res.status(500).send("Failed to update profile.");
//     }
// });

app.post('/api/u/:username/update/username', authenticateToken, addUser, updateUsername)

app.post('/api/u/:username/update/displayname', authenticateToken, addUser, updateDisplayname)

app.post('/api/u/:username/update/email', authenticateToken, addUser, updateEmail)

app.post('/api/u/:username/update/password', authenticateToken, addUser, updatePassword)

app.post('/api/u/:username/update/avatar', authenticateToken, addUser, upload.single('avatar'), updateAvatar)

// HTTP post endpoint to shop
app.post('/shop', addUser, async (req, res) => {
    const { product } = req.body;
    const userId = req.user.userId; // Assuming userId is available from session or token
    const username = req.user ? req.user.username : null
    try {
        // Check if the prize exists and get its cost
        const prizes = await getQuery('SELECT prizeId, cost, prize FROM prizes WHERE prizeId = ?', [product]);
        
        if (prizes.length === 0) {
            return res.status(404).json({ success: false, message: "Prize not found" });
        }
        const prize = prizes[0];

        // Check if the user has enough points
        const users = await getQuery('SELECT points_balance FROM users WHERE userId = ?', [userId]);
        if (users.length === 0 || users[0].points_balance < prize.cost) {
            return res.status(400).json({ success: false, message: "Insufficient coins" });
        }

        // Deduct the prize cost from the user's points balance
        await runQuery('UPDATE users SET points_balance = points_balance - ? WHERE userId = ?', [prize.cost, userId]);

        // Log the transaction
        const transactionId = uuidv4();
        await runQuery('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)', 
                     [transactionId, userId, `purchase of ${prize.prize}`, -prize.cost]);

        // Send an email notification
        const msg = {
            to: 'pb@publicaccess.tv', // Recipient email address
            from: 'no-reply@publicaccess.tv', // Your verified sender
            subject: 'Purchase Notification',
            text: `User ${username} purchased ${prize.prize} for ${prize.cost} coins.`,
            html: `<strong>User ${username} purchased ${prize.prize} for ${prize.cost} coins.</strong>`,
        };
        await sgMail.send(msg);

        // Respond to the user
        res.json({ success: true, message: "Purchase successful" });
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).send("Failed to process the purchase.");
    }
});


// Function to get the total jackpot
function getJackpotTotal(req, res) {
    db.get("SELECT SUM(amount) AS total FROM jackpot_rakes", (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        return res.json({ jackpotTotal: row.total || 0 }); // Return 0 if null
    });
}

// Function to get the username from a userId
function getUsername(userId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT username FROM users WHERE userId = ?`, [userId], (err, row) => {
            if (err) {
                reject(err.message); // Reject the promise with the error
            } else if (row) {
                resolve(row.username); // Resolve the promise with the username
            } else {
                reject('User not found'); // Reject if no user is found
            }
        });
    });
}

// Function to get the User Balance
function getUserBalance(req, res) {
    const username = req.params.username;
    db.get(`SELECT points_balance FROM users WHERE username = ?`, [username], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (row) {
            return res.json({ balance: row.points_balance });
        } else {
            return res.status(404).json({ error: 'User not found' });
        }
    });
}

// HTTP GET endpoint to get the list of classes
app.get('/api/classes', async (req, res) => {
    const sql = 'SELECT class FROM classes';
    try {
        db.all(sql, [], (err, rows) => {
            if (err) {
                console.error(err.message);
                res.status(500).send("Failed to retrieve classes.");
                return;
            }
            // Ensure to send an array of class names
            const classNames = rows.map(row => row.class);
            res.json(classNames);
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("Failed to retrieve classes.");
    }
});

// HTTP GET endpoint to get the list of prizes with their costs
app.get('/api/prizes', async (req, res) => {
    const sql = 'SELECT prizeId, prize, cost FROM prizes'; // Updated SQL to fetch the cost as well
    try {
        db.all(sql, [], (err, rows) => {
            if (err) {
                console.error(err.message);
                res.status(500).send("Failed to retrieve prizes.");
                return;
            }
            // Send an array of objects with both prize names and costs
            res.json(rows.map(row => {
                return { prize: row.prize, cost: row.cost, prizeId: row.prizeId };
            }));
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("Failed to retrieve prizes.");
    }
});

// HTTP GET endpoint to get user balance
app.get('/api/u/:username/balance', getUserBalance)

// HTTP GET endpoint to retrieve the jackpot total.
app.get('/api/jackpot', getJackpotTotal);

// HTTP GET endpoint to show the wheel.
app.get('/u/:username/wheel', authenticateToken, async (req, res) => {
    const username = req.params.username;
    try {
        if (req.username !== username) {
            req.flash('error', 'Invalid login.');
            return res.redirect('/login');
        }
        res.render('wheel', {user: req.username});
        // Proceed with fetching user data and generating wheel
    } catch (error) {
        res.status(500).json({ error: error });
    }
});

// HTTP GET endpoint to show the public wheel.
app.get('/g/wheel', addUser, (req, res) => {
        const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
        res.render('publicwheel', { user: username });
        // Proceed with fetching user data and generating wheel
});

// HTTP Post endpoint to update the jackpot
app.post('/api/g/wheel/jackpot', addUser, async (req, res) => {
    const { amount } = req.body;
    const userId = req.user.userId; // Assuming this is set by the authenticateToken middleware
    const jackpotId = uuidv4(); // Function to generate a UUID v4
    const spinId = uuidv4();
    const userType = req.user ? req.user.class : null;
    const username = req.user ? req.user.username : null;
    if (userType === 'Admin' || userType === 'Staff') {
        const sql = `INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)`;
        try {
            await runQuery(sql, [jackpotId, spinId, userId, amount]);
            res.json({ message: "Jackpot updated successfully." });
            // req.flash('success', "Jackpot updated successfully.");
            // return res.redirect('/admin/panel');
        } catch (error) {
            console.error(error);
            res.json({ message: "Failed to update the jackpot." });
            // req.flash('error', "Failed to update the jackpot.");
            // return res.redirect('/admin/panel');
        }
    } else {
        req.flash('error', "Access denied. You must be an admin or staff to access this page.");
        return res.redirect('/login');
    }
});

// HTTP Post Endpoint To Get Last 100 Spin Results
app.post('/api/g/wheel/results', async (req, res) => {
    const sql = `
        SELECT userId, result
        FROM wheel_spins
        ORDER BY timestamp DESC
        LIMIT 100
    `;

    try {
        const results = await getQuery(sql); // Assuming getQuery can handle multiple rows and is adjusted accordingly
        res.json(results);
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).send("Failed to retrieve wheel spin results.");
    }
});

// HTTP Post endpoint to update the user balance.
app.post('/api/admin/transfer/:username', authenticateToken, addUser, async (req, res) => {
    const amount  = req.body.amount;
    const username = req.params.username;
    const userType = req.user ? req.user.class : null;
    const transactionId = uuidv4(); // Function to generate a UUID v4

    if (userType === 'Admin' || userType === 'Staff') {
        // Begin transaction to ensure atomicity
        db.serialize(async () => {
            db.run("BEGIN TRANSACTION");
            try {
                // Update user's balance
                let sql = `UPDATE users SET points_balance = points_balance + ? WHERE username = ?`;
                await runQuery(sql, [amount, username]);

                // Log the transaction
                sql = `INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)`;
                const user = await getQuery(`SELECT userId FROM users WHERE username = ?`, [username]);
                console.log(user);
                await runQuery(sql, [transactionId, user[0].userId, "staff transfer", amount]);

                db.run("COMMIT");
                res.json({ message: "Points transferred successfully." });
            } catch (error) {
                db.run("ROLLBACK");
                console.error(error);
                res.status(500).send("Failed to transfer points.");
            }
        });
    } else {
        req.flash('error', "Access denied. You must be an admin or staff to access this page.");
        return res.redirect('/login');
    }
});

// HTTP POST endpoint to update a user class.
app.post('/api/u/:username/class/update', addUser, async (req, res) => {
    console.log(req.user);
    const userType = req.user ? req.user.class : null;
    const username = req.user ? req.user.username : null;
    if (userType === 'Admin' || userType === 'Staff') {
        const username = req.params.username;
        const userClass = req.body.class;
    
        const sql = 'UPDATE users SET class = ? WHERE username = ?';
        try {
            const result = await runQuery(sql, [userClass, username]);
            if (result.changes) {
                res.json({ message: "User class updated successfully." });
            } else {
                res.status(404).send("User not found.");
            }
        } catch (error) {
            console.error(error);
            res.status(500).send("Failed to update user class.");
        }
    } else {
        req.flash('error', "Access denied. You must be an admin or staff to access this page.");
        return res.redirect('/login');
    }
});

// HTTP POST endpoint to edit the list of classes.
app.post('/api/classes/edit', addUser, async (req, res) => {
    console.log(req.user);
    const userType = req.user ? req.user.class : null;
    const username = req.user ? req.user.username : null;
    if (userType === 'Admin' || userType === 'Staff') {
        const { action, className } = req.body;

        if (action === 'add') {
            // First, check if the prize already exists
            const checkSql = 'SELECT classId FROM classes WHERE class = ?';
            const result = await getQuery(checkSql, [className]);
            const existingPrize = result[0]; // Assuming getQuery returns an array of results

            if (existingPrize) {
                // If it exists, don't do anything.
                res.status(200).send("Class already exists.");
            } else {
                // If it does not exist, add new class
                const classId = uuidv4(); // Function to generate a UUID v4
                const sql = 'INSERT INTO classes (classId, class) VALUES (?, ?)';
                try {
                    await runQuery(sql, [classId, className]);
                    res.json({ message: "Class added successfully." });
                } catch (error) {
                    console.error(error);
                    res.status(500).send("Failed to add class.");
                }
            }
        } else if (action === 'remove') {
            const sql = 'DELETE FROM classes WHERE class = ?';
            try {
                const result = await runQuery(sql, [className]);
                if (result.changes) {
                    res.json({ message: "Class removed successfully." });
                } else {
                    res.status(404).send("Class not found.");
                }
            } catch (error) {
                console.error(error);
                res.status(500).send("Failed to remove class.");
            }
        } else {
            res.status(400).send("Invalid action specified.");
        }
    } else {
        req.flash('error', "Access denied. You must be an admin or staff to access this page.");
        return res.redirect('/login');
    }
});

// HTTP POST endpoint to edit the list of classes.
app.post('/api/prizes/edit', addUser, async (req, res) => {
    const userType = req.user ? req.user.class : null;
    if (userType === 'Admin' || userType === 'Staff') {
        const { action, prizeName, cost } = req.body;

        try {
            if (action === 'add') {
                // First, check if the prize already exists
                const checkSql = 'SELECT prizeId FROM prizes WHERE prize = ?';
                const result = await getQuery(checkSql, [prizeName]);
                const existingPrize = result[0]; // Assuming getQuery returns an array of results

                if (existingPrize) {
                    // If it exists, update the cost
                    const updateSql = 'UPDATE prizes SET cost = ? WHERE prizeId = ?';
                    await runQuery(updateSql, [cost, existingPrize.prizeId]);
                    res.json({ message: "Prize cost edited successfully." });
                } else {
                    // If it does not exist, add new prize
                    const prizeId = uuidv4();
                    const insertSql = 'INSERT INTO prizes (prizeId, prize, cost) VALUES (?, ?, ?)';
                    await runQuery(insertSql, [prizeId, prizeName, cost]);
                    res.json({ message: "Prize added successfully." });
                }
            } else if (action === 'remove') {
                const deleteSql = 'DELETE FROM prizes WHERE prize = ?';
                const result = await runQuery(deleteSql, [prizeName]);
                if (result.changes) {
                    res.json({ message: "Prize removed successfully." });
                } else {
                    res.status(404).send("Prize not found.");
                }
            } else {
                res.status(400).send("Invalid action specified.");
            }
        } catch (error) {
            console.error(error);
            res.status(500).send("Failed to process prize.");
        }
    } else {
        req.flash('error', "Access denied. You must be an admin or staff to access this page.");
        return res.redirect('/login');
    }
});

// HTTP POST endpoint to trigger wheel spin
app.post('/api/u/:username/wheel/spin', authenticateToken, async (req, res) => {
    const username = req.body.username;
    const pageId = req.body.pageId;
    
    if (req.username !== username) {
        return res.status(403).send("Access denied");
    }

    try {
        checkAndResolvePendingSpins();
        const users = await getQuery(`SELECT userId, points_balance FROM users WHERE username = ?;`, [username]);
        const user = users[0]; // Since getQuery uses db.all, it returns an array

        if (!user) {
            return res.status(404).send('User not found');
        }

        if (user.points_balance < 5000) {
            return res.status(400).send('Insufficient points');
        }

        const pendingSpins = await getQuery(`SELECT * FROM wheel_spins WHERE result = 'PENDING' AND type = 'gold' AND userId = ? ORDER BY rowid DESC LIMIT 1;`, [user.userId]);
        const pendingSpin = pendingSpins[0]; // Since getQuery uses db.all, it returns an array

        if (pendingSpin) {
            return res.status(400).send('Free spin in progress.');
        }

        await runQuery('BEGIN TRANSACTION');

        const spinId = uuidv4();
        const transactionId = uuidv4();
        const jackpotId = uuidv4();

        await runQuery(`UPDATE users SET points_balance = points_balance - 5000 WHERE userId = ?;`, [user.userId]);
        await runQuery(`INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?);`, [transactionId, user.userId, "Wager: Gold Spin", -5000]);
        await runQuery(`INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?);`, [jackpotId, spinId, user.userId, 500]);
        await runQuery(`INSERT INTO wheel_spins (spinId, userId, type, result, transactionId) VALUES (?, ?, ?, ?, ?);`, [spinId, user.userId, 'gold', 'PENDING', transactionId]);

        await runQuery('COMMIT');

        sendEvent('spin', pageId, { message: `Spin: ${username}`, timestamp: new Date() });

        res.json({ spinId });
    } catch (error) {
        await runQuery('ROLLBACK');
        console.error('Failed to process spin:', error);
        res.status(500).send('Failed to process spin');
    }
});

// HTTP POST endpoint to trigger a public wheel spin
app.post('/api/g/wheel/spin', authenticateToken, async (req, res) => {
    const username = req.body.username;
    const pageId = req.body.pageId;
    
    if (req.username !== username) {
        return res.status(403).send("Access denied");
    }

    try {
        checkAndResolvePendingSpins();
        const users = await getQuery(`SELECT userId, points_balance FROM users WHERE username = ?;`, [username]);
        const user = users[0]; // Since getQuery uses db.all, it returns an array

        if (!user) {
            return res.status(404).send('User not found');
        }

        if (user.points_balance < 5000) {
            return res.status(400).send('Insufficient points');
        }

        const pendingSpins = await getQuery(`SELECT * FROM wheel_spins WHERE result = 'PENDING' AND type = 'public' ORDER BY rowid DESC LIMIT 1;`);
        const pendingSpin = pendingSpins[0]; // Since getQuery uses db.all, it returns an array

        if (pendingSpin) {
            return res.status(400).send('Free spin in progress.');
        }

        await runQuery('BEGIN TRANSACTION');

        const spinId = uuidv4();
        const transactionId = uuidv4();
        const jackpotId = uuidv4();

        await runQuery(`UPDATE users SET points_balance = points_balance - 5000 WHERE userId = ?;`, [user.userId]);
        await runQuery(`INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?);`, [transactionId, user.userId, "Wager: Public Spin", -5000]);
        await runQuery(`INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?);`, [jackpotId, spinId, user.userId, 500]);
        await runQuery(`INSERT INTO wheel_spins (spinId, userId, type, result, transactionId) VALUES (?, ?, ?, ?, ?);`, [spinId, user.userId, 'public', 'PENDING', transactionId]);

        await runQuery('COMMIT');

        const spinData = { message: `public spinid ${spinId} from ${username}`, timestamp: new Date() };
        sendEvent('spin', 'public', spinData);

        res.json({ spinId });
    } catch (error) {
        await runQuery('ROLLBACK');
        console.error('Failed to process spin:', error);
        res.status(500).send('Failed to process spin');
    }
});

// Prune pending/unresolved spins.
const checkAndResolvePendingSpins = () => {
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 30000);  // 30000 milliseconds = 30 seconds
    let sqliteTimestamp = oneMinuteAgo.toISOString().replace('T', ' ').slice(0, 19);
    console.log("Current time:", now);
    console.log("One minute ago:", oneMinuteAgo);

    db.all(`SELECT spinId, userId, timestamp FROM wheel_spins WHERE result = 'PENDING' AND timestamp < ?`, [sqliteTimestamp], (err, spins) => {
        if (err) {
            console.error("Error fetching pending spins:", err);
            return;
        }

        if (spins.length === 0) {
            console.log("No pending spins older than one minute.");
            return;
        }

        console.log(`Found ${spins.length} pending spins to process.`);
        spins.forEach(spin => {
            console.log(`Processing spin: ${spin.spinId}, Timestamp: ${spin.timestamp}`);
            // Update spin status to FAILED
            db.run(`UPDATE wheel_spins SET result = 'FAILED' WHERE spinId = ?`, [spin.spinId], (err) => {
                if (err) {
                    console.error("Error updating spin status for spin ID " + spin.spinId + ":", err);
                    return;
                }
                // Refund logic here
                refundUser(spin.userId, spin.spinId);
            });
        });
    });
};

// Function to handle refund
const refundUser = (userId, spinId) => {
    console.log(`Refunding user ${userId} for spin ${spinId}`);
    const transactionId = uuidv4();
    const transactionType = "Refund";
    const jackpotId = uuidv4();

    // Start a transaction
    db.serialize(() => {
        db.run('BEGIN');

        const updateTransaction = `INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)`;
        const updateBalance = `UPDATE users SET points_balance = points_balance + 5000 WHERE userId = ?`;
        const updateJackpot = `INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)`;

        db.run(updateTransaction, [transactionId, userId, transactionType, +5000], function(err) {
            if (err) {
                console.error("Error inserting transaction:", err);
                db.run('ROLLBACK');
                return;
            }

            db.run(updateBalance, [userId], function(err) {
                if (err) {
                    console.error("Error updating user balance:", err);
                    db.run('ROLLBACK');
                    return;
                }

                db.run(updateJackpot, [jackpotId, spinId, userId, -100], function(err) {
                    if (err) {
                        console.error("Error updating jackpot rakes:", err);
                        db.run('ROLLBACK');
                        return;
                    }

                    // If all operations are successful, commit the transaction
                    db.run('COMMIT', err => {
                        if (err) {
                            console.error("Error committing transaction:", err);
                            return;
                        }
                        console.log("Refund processed successfully for user", userId);
                    });
                });
            });
        });
    });
};

// Set interval to run this cleanup function every minute
// setInterval(checkAndResolvePendingSpins, 5000);

// HTTP POST endpoint to record the result of a public wheel spin.
app.post('/api/g/wheel/spin/result', (req, res) => {
    const { spinId, result } = req.body;
    const transactionType = "Reward: Public Spin";
    const transactionId = uuidv4();
    // Update the wheel spin table with the result.
    db.run('UPDATE wheel_spins SET result = ? WHERE spinId = ?', [result, spinId]);

    let userId = 0;

    db.serialize(() => {
        // Find the UserId associated with the Spin.
        db.get(`SELECT userId FROM wheel_spins WHERE spinId = ?;`,[spinId], (err, row) => {
            if (err) {
                console.error('Error executing SQL: ' + err.message);
            } else {
                if (row) {
                    console.log('UserId found:', row.userId);
                    userId = row.userId;
                    if (result.includes("JACKPOT") === true) { // Check if there is a JACKPOT.
                        db.get("SELECT SUM(amount) AS total FROM jackpot_rakes", (err, row) => {
                            if (err) {
                                return;
                            }
                        let jackpotTotal = row.total; // Return 0 if null
                        // Add jackpot to the user balance.
                        db.run(`UPDATE users SET points_balance = points_balance + ${jackpotTotal} WHERE userId = ?`, [userId]);

                        // Clear the Jackpot.
                        db.run(`INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)`, 
                            [uuidv4(), spinId, userId, -jackpotTotal], (err) => {
                                if (err) {
                                    return res.status(500).json({ error: 'Failed to create spin record' });
                                    }
                            });

                        // Log the transaction.
                        db.run('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)',
                            [transactionId, userId, 'Jackpot Win', jackpotTotal], (err) => {
                                if (err) {
                                return res.status(500).json({ error: 'Failed to create spin record' });
                                }
                                sendEvent("results", spinId, { result: jackpotTotal });
                                res.status(200).json({ transactionId: transactionId, result: jackpotTotal });
                        }); 
                        });
                    }

                    else {
                    // Add points to the user balance.
                    db.run(`UPDATE users SET points_balance = points_balance + ${result} WHERE userId = ?`, [userId]);
            
                    // Log the transaction.
                    db.run('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)',
                        [transactionId, userId, transactionType, result], (err) => {
                            if (err) {
                            return res.status(500).json({ error: 'Failed to create spin record' });
                            }
                            console.log(transactionId);
                            // Send a message to connected clients to spin the wheel.
                            console.log("sending spin data to clients" + spinId + result);
                            sendEvent("results", spinId, { result: result });
                            res.status(200).json({ transactionId: transactionId, result: result });
                    });
                    }
                } else {
                    console.log('No matching record found for the given spinId');
                    return res.status(500).json({ error: 'Failed to create spin record' });
                }
            }
        });
      });
});

// HTTP POST endpoint to record the result of a wheel spin.
app.post('/api/u/:username/wheel/spin/result', authenticateToken, (req, res) => {
    const { spinId, result } = req.body;
    const transactionType = "Reward: Gold Spin";
    const transactionId = uuidv4();
    // Update the wheel spin table with the result.
    db.run('UPDATE wheel_spins SET result = ? WHERE spinId = ?', [result, spinId]);

    let userId = 0;

    db.serialize(() => {
        // Find the UserId associated with the Spin.
        db.get(`SELECT userId FROM wheel_spins WHERE spinId = ?;`,[spinId], (err, row) => {
            if (err) {
                console.error('Error executing SQL: ' + err.message);
            } else {
                if (row) {
                    console.log('UserId found:', row.userId);
                    userId = row.userId;
                    if (result.includes("JACKPOT") === true) { // Check if there is a JACKPOT.
                        db.get("SELECT SUM(amount) AS total FROM jackpot_rakes", (err, row) => {
                            if (err) {
                                return;
                            }
                        let jackpotTotal = row.total; // Return 0 if null
                        // Add jackpot to the user balance.
                        db.run(`UPDATE users SET points_balance = points_balance + ${jackpotTotal} WHERE userId = ?`, [userId]);

                        // Clear the Jackpot.
                        db.run(`INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)`, 
                            [uuidv4(), spinId, userId, -jackpotTotal], (err) => {
                                if (err) {
                                    return res.status(500).json({ error: 'Failed to create spin record' });
                                    }
                            });

                        // Log the transaction.
                        db.run('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)',
                            [transactionId, userId, 'Jackpot Win', jackpotTotal], (err) => {
                                if (err) {
                                return res.status(500).json({ error: 'Failed to create spin record' });
                                }

                                res.status(200).json({ transactionId: transactionId, result: jackpotTotal });
                        }); 
                        });
                    }

                    else {
                    // Add points to the user balance.
                    db.run(`UPDATE users SET points_balance = points_balance + ${result} WHERE userId = ?`, [userId]);
            
                    // Log the transaction.
                    db.run('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)',
                        [transactionId, userId, transactionType, result], (err) => {
                            if (err) {
                            return res.status(500).json({ error: 'Failed to create spin record' });
                            }

                            res.status(200).json({ transactionId: transactionId, result: result });
                    });
                    }
                } else {
                    console.log('No matching record found for the given spinId');
                    return res.status(500).json({ error: 'Failed to create spin record' });
                }
            }
        });
      });
});

// Server-Sent Events setup to send commands to the client
app.get('/events', (req, res) => {
    const { type, identifier } = req.query;  // 'type' could be 'spin' or 'results'

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.flushHeaders(); // Flush the headers to establish SSE connection

    // Register this connection to receive updates for the specified spinId
    registerClient(type, identifier, res);

    req.on('close', () => {
        unregisterClient(type, identifier, res); // Clean up when the client disconnects
        res.end();
    });

});

function registerClient(type, identifier, res) {
    if (!clients[type]) {
        clients[type] = {};
    }
    if (!clients[type][identifier]) {
        clients[type][identifier] = [];
    }
    clients[type][identifier].push(res);
}

function unregisterClient(type, identifier, res) {
    clients[type][identifier] = clients[type][identifier].filter(client => client !== res);
    if (clients[type][identifier].length === 0) {
        delete clients[type][identifier];
    }
    res.end();
}

// Function to send events to clients listening for them.
function sendEvent(type, identifier, message) {
    const data = JSON.stringify(message);
    if (clients[type] && clients[type][identifier]) {
        clients[type][identifier].forEach(client => client.write(`data: ${data}\n\n`));
    }
}

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

