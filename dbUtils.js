// dbUtils.js
const sqlite3 = require('sqlite3').verbose();

// Connect to SQLite database
const db = new sqlite3.Database('./myapp.db', (err) => {
    if (err) {
        console.error('Error opening database ' + err.message);
    } else {
        console.log('Database connected.');
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
        email TEXT UNIQUE,
        password TEXT NOT NULL,
        discordId TEXT,
        discordUsername TEXT,
        twitchId TEXT,
        twitchDisplayname TEXT,
        streamId TEXT,
        streamKey TEXT,
        points_balance INTEGER DEFAULT 0,
        liked INTEGER DEFAULT 0,
        discordBonus INTEGER DEFAULT 0,
        discordBonus_at TIMESTAMP,
        twitchBonus INTEGER DEFAULT 0,
        twitchBonus_at TIMESTAMP,
        emailVerificationToken VARCHAR(255),
        tokenExpires DATETIME,
        isEmailVerified INTEGER DEFAULT 0,
        resetPasswordToken TEXT,
        resetPasswordExpires DATETIME,
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
            console.log('Error creating table wheel_spins', err);
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
            console.log('Error creating table jackpot_rakes', err);
        } else {
            console.log('Table jackpot_rakes created or already exists.');
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS classes (
        classId TEXT PRIMARY KEY,
        class TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.log('Error creating table classes', err);
        } else {
            console.log('Table classes created or already exists.');
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS prizes (
        prizeId TEXT PRIMARY KEY,
        prize TEXT NOT NULL,
        cost INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.log('Error creating table prizes', err);
        } else {
            console.log('Table prizes created or already exists.');
        }
    });
    // Add additional tables as needed
}

// Utility functions for inserting and updating data
function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ id: this.lastID, changes: this.changes });
            }
        });
    });
}

function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, results) => {
            if (err) {
                reject(err);
            } else {
                resolve(results);
            }
        });
    });
}

module.exports = { createTables, runQuery, getQuery };