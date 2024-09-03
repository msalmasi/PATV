const express = require('express');
const cors = require('cors');
const app = express();
const fs = require('fs');
const path = require('path');
const port = 3000;
const sqlite3 = require('sqlite3').verbose()
const { v4: uuidv4 } = require('uuid');

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
        avatar TEXT NOT NULL DEFAULT avatar.png,
        displayname TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        discordId TEXT,
        twitchId TEXT,
        streamId TEXT,
        streamKey TEXT,
        points_balance INTEGER DEFAULT 0,
        liked INTEGER DEFAULT 0,
        claimBonus INTEGER DEFAULT 0,
        claimBonus_at TIMESTAMP,
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

let clients = []; // Keep track of connected clients for SSE

// Serve static files from the public directory
app.use('/public', express.static('public'));

// HTTP GET endpoint to get user balance
app.get('/api/u/:username/balance', (req, res) => {
    const username = req.params.username;
    db.get(`SELECT points_balance FROM users WHERE username = ?`, [username], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
            console.log('points pb ' + error)
        }
        if (row) {
            return res.json({ balance: row.points_balance });
            console.log('points pb ' + row)
        } else {
            return res.status(404).json({ error: 'User not found' });
            console.log('points pb 404')
        }
    });
});

// Function to get the total jackpot
function getJackpotTotal(req, res) {
    db.get("SELECT SUM(amount) AS total FROM jackpot_rakes", (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ jackpotTotal: row.total || 0 }); // Return 0 if null
    });
}

// HTTP GET endpoint to retrieve the jackpot total.
app.get('/api/jackpot', getJackpotTotal);

// HTTP GET endpoint to retrieve the Gold Wheel page.
app.get('/u/:username/wheel', (req,res) => {
    const username = "pb";
    res.sendFile("B:/OneDrive/Documents/PATV/index.html");
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
                                    db.run('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)', [spinId, userId, transactionType, -5000]);

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