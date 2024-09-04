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
const { registerUser, loginUser } = require('./user.controller');
const authenticateToken = require('./middleware/authenticateToken');
const cookieParser = require('cookie-parser');


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

// Cookie Parser Middleware
app.use(cookieParser()); 

// Connect to SQLite database
const db = new sqlite3.Database('./myapp.db', (err) => {
    if (err) {
        console.error('Error opening database ' + err.message);
    } else {
        console.log('Database connected.');
        createTables();
    }
});

// Setup DB
function createTables() {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        userId TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        avatar TEXT NOT NULL DEFAULT "avatar.png",
        class TEXT NOT NULL DEFAULT "pleb",
        displayname TEXT,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        discordId TEXT,
        twitchId TEXT,
        streamId TEXT,
        streamKey TEXT,
        points_balance INTEGER DEFAULT 0,
        liked INTEGER DEFAULT 0,
        discordBonus INTEGER DEFAULT 0,
        discordBonus_at TIMESTAMP,
        twitchBonus INTEGER DEFAULT 0,
        twitchBonus_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.log('Error creating table users', err);
        } else {
            console.log('Table users created or already exists.');
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        transactionId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        type TEXT NOT NULL,
        points INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId)
    )`, (err) => {
        if (err) {
            console.log('Error creating table transactions', err);
        } else {
            console.log('Table transactions created or already exists.');
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS wheel_spins (
        spinId TEXT PRIMARY KEY,
        type TEXT,
        userId TEXT,
        result TEXT NOT NULL,
        transactionId TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
    )`, (err) => {
        if (err) {
            console.log('Error creating table transactions', err);
        } else {
            console.log('Table wheel_spins created or already exists.');
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS jackpot_rakes (
        jackpotId TEXT PRIMARY KEY,
        spinId TEXT,
        userId TEXT,
        amount INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (spinId) REFERENCES transactions(wheel_spins)
    )`, (err) => {
        if (err) {
            console.log('Error creating table transactions', err);
        } else {
            console.log('Table jackpot_rakes created or already exists.');
        }
    });
    // Add additional tables as needed
}

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

// Example route with authentication middleware
app.get('/protected', authenticateToken, (req, res) => {
    res.json({ message: 'Protected route accessed successfully.' });
  });

app.get('/register', addUser, async (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    res.render('register', { user: username });
});

app.get('/login', addUser, (req, res) => {
    const username = req.user ? req.user.username : null;  // Fallback to null if no user in session
    res.render('login', { user: username });
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

// HTTP GET endpoint to get user balance
app.get('/api/u/:username/balance', getUserBalance)

// HTTP GET endpoint to retrieve the jackpot total.
app.get('/api/jackpot', getJackpotTotal);

// HTTP GET endpoint to show the wheel.
app.get('/u/:username/wheel', authenticateToken, async (req, res) => {
    const username = req.params.username;
    try {
        if (req.username !== username) {
            console.log(req.userId);
            return res.status(403).send("Access denied");
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

// HTTP POST endpoint to trigger wheel spin
app.post('/api/u/:username/wheel/spin', (req, res) => {
    const username = req.body.username;
    let userId = 0;

    // Use the username to resolve the userId
    db.get(`SELECT userId FROM users WHERE username = ?;`,[username], (err, row) => {
        if (err) {
            console.error('Error executing SQL: ' + err.message);
        } else {
            if (row) {
                console.log('UserId found:', row.userId);
                userId = row.userId;
                    // Check if there is a spin in progress.
                    db.get(`SELECT * FROM wheel_spins WHERE result = ? AND userId = ? ORDER BY rowid DESC LIMIT 1;`,['PENDING', userId], (err, row) => {
                        if(typeof row !== 'undefined') {
                            let error = username +' rejected. Spin in progress.'
                            console.log(error)
                            return res.status(400).json({ error: 'Free spin in progress.' });
                        }
                        
                        else {
                            // Check if the user has enough points
                            console.log(`user is ${userId}`)
                            console.log(row)
                            db.get('SELECT points_balance FROM users WHERE userId = ?', [userId], (err, row) => {
                                console.log(userId);
                                console.log(row);
                                if (err) {
                                    return res.status(500).json({ error: 'Database error' });
                                }
                            
                                if (row.points_balance < 5000) {
                                    return res.status(400).json({ error: 'Insufficient points' });
                                }
                            
                                const spinId = uuidv4();
                                const transactionId = uuidv4();
                                const jackpotId = uuidv4();
                                const transactionType = "Wager: Gold Spin";

                                // Send a message to connected clients to spin the wheel.
                                const spinData = { message: `Spin: ${username}`, timestamp: new Date() };
                                clients.forEach(client => client.res.write(`data: ${JSON.stringify(spinData)}\n\n`)); // Notify all clients

                                
                                db.serialize(() => {
                                    // Deduct points from user balance.
                                    db.run('UPDATE users SET points_balance = points_balance - 5000 WHERE userId = ?', [userId]);
                                    
                                    // Update the wheel spins log.
                                    db.run('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)', [transactionId, userId, transactionType, -5000]);

                                    // Add to the jackpot.
                                    db.run('INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)', [jackpotId, spinId, userId, 100]);

                                    // Update the transaction log.
                                    db.run('INSERT INTO wheel_spins (spinId, userId, result, transactionId) VALUES (?, ?, ?, ?)', 
                                        [spinId, userId, 'PENDING', transactionId], (err) => {
                                            if (err) {
                                                return res.status(500).json({ error: 'Failed to create spin record' });
                                            }

                                            res.status(200).json({ spinId });
                                    });
                                });
                            });
                            }
                    });
            } else {
                console.log('No matching record found for the given userId');
                return res.status(500).json({ error: 'Failed to create spin record' });
            }
        }
    });


});

// HTTP POST endpoint to trigger a public wheel spin
app.post('/api/g/wheel/spin', (req, res) => {
    const username = req.body.username;
    let userId = 0;

    // Use the username to resolve the userId
    db.get(`SELECT userId FROM users WHERE username = ?;`,[username], (err, row) => {
        if (err) {
            console.error('Error executing SQL: ' + err.message);
        } else {
            if (row) {
                console.log('UserId found:', row.userId);
                userId = row.userId;
                    // Check if there is a spin in progress.
                    db.get(`SELECT * FROM wheel_spins WHERE result = ? AND username = ? ORDER BY rowid DESC LIMIT 1;`,['PENDING', 'public'], (err, row) => {
                        if(typeof row !== 'undefined') {
                            let error = username +' rejected. Spin in progress.'
                            console.log(error)
                            return res.status(400).json({ error: 'Free spin in progress.' });
                        }
                        
                        else {
                            // Check if the user has enough points
                            console.log(`user is ${userId}`)
                            console.log(row)
                            db.get('SELECT points_balance FROM users WHERE userId = ?', [userId], (err, row) => {
                                console.log(userId);
                                console.log(row);
                                if (err) {
                                    return res.status(500).json({ error: 'Database error' });
                                }
                            
                                if (row.points_balance < 5000) {
                                    return res.status(400).json({ error: 'Insufficient points' });
                                }
                            
                                const spinId = uuidv4();
                                const transactionId = uuidv4();
                                const jackpotId = uuidv4();
                                const transactionType = "Wager: Gold Spin";

                                // Send a message to connected clients to spin the wheel.
                                const spinData = { message: `Spin: public`, timestamp: new Date() };
                                clients.forEach(client => client.res.write(`data: ${JSON.stringify(spinData)}\n\n`)); // Notify all clients

                                
                                db.serialize(() => {
                                    // Deduct points from user balance.
                                    db.run('UPDATE users SET points_balance = points_balance - 5000 WHERE userId = ?', [userId]);
                                    
                                    // Update the wheel spins log.
                                    db.run('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)', [transactionId, userId, transactionType, -5000]);

                                    // Add to the jackpot.
                                    db.run('INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)', [jackpotId, spinId, userId, 100]);

                                    // Update the transaction log.
                                    db.run('INSERT INTO wheel_spins (spinId, userId, result, transactionId) VALUES (?, ?, ?, ?)', 
                                        [spinId, userId, 'PENDING', transactionId], (err) => {
                                            if (err) {
                                                return res.status(500).json({ error: 'Failed to create spin record' });
                                            }

                                            res.status(200).json({ spinId });
                                    });
                                });
                            });
                            }
                    });
            } else {
                console.log('No matching record found for the given userId');
                return res.status(500).json({ error: 'Failed to create spin record' });
            }
        }
    });


});

// HTTP POST endpoint to trigger public wheel spin
app.post('/api/g/wheel/spin', (req, res) => {
    const username = req.body.username;
    let userId = 0;

    // Use the username to resolve the userId
    db.get(`SELECT userId FROM users WHERE username = ?;`,[username], (err, row) => {
        if (err) {
            console.error('Error executing SQL: ' + err.message);
        } else {
            if (row) {
                console.log('UserId found:', row.userId);
                userId = row.userId;
                    // Check if there is a spin in progress.
                    db.get(`SELECT * FROM wheel_spins WHERE result = ? AND userId = ? ORDER BY rowid DESC LIMIT 1;`,['PENDING', userId], (err, row) => {
                        if(typeof row !== 'undefined') {
                            let error = username +' rejected. Spin in progress.'
                            console.log(error)
                            return res.status(400).json({ error: 'Free spin in progress.' });
                        }
                        
                        else {
                            // Check if the user has enough points
                            console.log(`user is ${userId}`)
                            console.log(row)
                            db.get('SELECT points_balance FROM users WHERE userId = ?', [userId], (err, row) => {
                                console.log(userId);
                                console.log(row);
                                if (err) {
                                    return res.status(500).json({ error: 'Database error' });
                                }
                            
                                if (row.points_balance < 5000) {
                                    return res.status(400).json({ error: 'Insufficient points' });
                                }
                            
                                const spinId = uuidv4();
                                const transactionId = uuidv4();
                                const jackpotId = uuidv4();
                                const transactionType = "Wager: Gold Spin";

                                // Send a message to connected clients to spin the wheel.
                                const spinData = { message: `Spin: ${username}`, timestamp: new Date() };
                                clients.forEach(client => client.res.write(`data: ${JSON.stringify(spinData)}\n\n`)); // Notify all clients

                                
                                db.serialize(() => {
                                    // Deduct points from user balance.
                                    db.run('UPDATE users SET points_balance = points_balance - 5000 WHERE userId = ?', [userId]);
                                    
                                    // Update the wheel spins log.
                                    db.run('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)', [transactionId, userId, transactionType, -5000]);

                                    // Add to the jackpot.
                                    db.run('INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)', [jackpotId, spinId, userId, 100]);

                                    // Update the transaction log.
                                    db.run('INSERT INTO wheel_spins (spinId, userId, result, transactionId) VALUES (?, ?, ?, ?)', 
                                        [spinId, userId, 'PENDING', transactionId], (err) => {
                                            if (err) {
                                                return res.status(500).json({ error: 'Failed to create spin record' });
                                            }

                                            res.status(200).json({ spinId });
                                    });
                                });
                            });
                            }
                    });
            } else {
                console.log('No matching record found for the given userId');
                return res.status(500).json({ error: 'Failed to create spin record' });
            }
        }
    });


});

// Prune pending/unresolved spins.
const checkAndResolvePendingSpins = () => {
    const oneMinuteAgo = new Date(Date.now() - 60000);  // 60000 milliseconds = 1 minute
    db.all(`SELECT spinId, userId FROM wheel_spins WHERE result = 'PENDING' AND timestamp < ?`, [oneMinuteAgo.toISOString()], (err, spins) => {
        if (err) {
            console.error("Error fetching pending spins:", err);
            return;
        }
        spins.forEach(spin => {
            // Update spin status to FAILED
            db.run(`UPDATE wheel_spins SET result = 'FAILED' WHERE spinId = ?`, [spin.spinId], (err) => {
                if (err) {
                    console.error("Error updating spin status:", err);
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
    // Add refund logic, e.g., update user balance, log transaction, etc.
    const transactionId = uuidv4();
    const transactionType = "Refund";
    const jackpotId = uuidv4();
    db.run('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)', [transactionId, userId, transactionType, +5000]);
    db.run('UPDATE users SET points_balance = points_balance + 5000 WHERE userId = ?', [userId]);
    db.run('INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)', [jackpotId, spinId, userId, -100]);

};

// Set interval to run this cleanup function every minute
setInterval(checkAndResolvePendingSpins, 60000);

// HTTP POST endpoint to record the result of a wheel spin.
app.post('/api/u/:username/wheel/spin/result', (req, res) => {
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

                                res.status(200).json({ transactionId });
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

                            res.status(200).json({ transactionId });
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
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Flush the headers to establish SSE connection

    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };
    clients.push(newClient);

    req.on('close', () => {
        console.log(`Client ${clientId} Connection closed`);
        clients = clients.filter(client => client.id !== clientId);
    });
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});