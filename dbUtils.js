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
        xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 0,
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

    db.run(`CREATE TABLE IF NOT EXISTS bonus_winners (
        bonusId TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        userId TEXT NOT NULL,
        transactionId TEXT NOT NULL,
        amount INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
        )`, (err) => {
            if (err) {
                console.log('Error creating table bonus_winners', err);
            } else {
                console.log('Table bonus_winners created or already exists.');
            }
        });

    db.run(`CREATE TABLE IF NOT EXISTS poker_cashier (
        cashierId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        transactionId TEXT NOT NULL,
        amount INTEGER NOT NULL,
        action TEXT NOT NULL, -- 'buyin' or 'cashout'
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
        );`, (err) => {
            if (err) {
                console.log('Error creating table poker_cashier', err);
            } else {
                console.log('Table poker_cashier created or already exists.');
            }
        });

    db.run(`CREATE TABLE IF NOT EXISTS blackjack (
        blackjackId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        wager INTEGER NOT NULL,
        payout INTEGER DEFAULT 0,
        result TEXT, -- Win, Lose, Draw, Blackjack, etc.
        wagerTransactionId TEXT NOT NULL,
        payoutTransactionId TEXT,
        pvalue INTEGER, -- Player's final value
        spvalue INTEGER, -- Player's split final value (if applicable)
        dvalue INTEGER, -- Dealer's final value
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (wagerTransactionId) REFERENCES transactions(transactionId),
        FOREIGN KEY (payoutTransactionId) REFERENCES transactions(transactionId)
        );`, (err) => {
            if (err) {
                console.log('Error creating table blackjack', err);
            } else {
                console.log('Table blackjack created or already exists.');
            }
        });

    db.run(`CREATE TABLE IF NOT EXISTS user_redemptions (
        redemption_id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        code TEXT NOT NULL,
        redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (code) REFERENCES redemption_codes(code)
    )`, (err) => {
        if (err) {
            console.log('Error creating table user_redemptions', err);
        } else {
            console.log('Table user_redemptions created or already exists.');
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS redemption_codes (
        code TEXT PRIMARY KEY,
        points INTEGER NOT NULL,
        uses_allowed INTEGER DEFAULT 1,
        uses_remaining INTEGER DEFAULT 1,
        expiration_date DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.log('Error creating table redemption_codes', err);
        } else {
            console.log('Table redemption_codes created or already exists.');
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
        FOREIGN KEY (spinId) REFERENCES wheel_spins(spinId)
    )`, (err) => {
        if (err) {
            console.log('Error creating table jackpot_rakes', err);
        } else {
            console.log('Table jackpot_rakes created or already exists.');
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS levels (
        level INTEGER PRIMARY KEY,
        xp_required INTEGER NOT NULL,
        points_reward INTEGER NOT NULL
    )`, (err) => {
        if (err) {
            console.log('Error creating table levels', err);
        } else {
            console.log('Table levels created or already exists.');
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

    db.run(`
        CREATE TABLE IF NOT EXISTS badges (
          badgeId TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          icon TEXT,
          points INTEGER DEFAULT 0,
          requirement TEXT NOT NULL,
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.log('Error creating table badges', err);
            } else {
                console.log('Table badges created or already exists.');
            }
        });
  
      db.run(`
        CREATE TABLE IF NOT EXISTS user_badges (
          userId TEXT NOT NULL,
          badgeId TEXT NOT NULL,
          awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (userId, badgeId),
          FOREIGN KEY (userId) REFERENCES users(userId),
          FOREIGN KEY (badgeId) REFERENCES badges(badgeId)
               )`, (err) => {
            if (err) {
                console.log('Error creating table user_badges', err);
            } else {
                console.log('Table user_badges created or already exists.');
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
    db.serialize(() => {
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_code ON user_redemptions (userId, code);`, (err) => {
          if (err) {
            return console.error("Error creating unique index:", err.message);
          }
          console.log("Unique index created successfully.");
        });
      });
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

// Close the database connection when the Node.js process terminates
process.on('SIGINT', () => {
    db.close((err) => {
      if (err) {
        console.error('Error closing the database', err.message);
      }
      console.log('Database connection closed.');
      process.exit(0);
    });
  });

module.exports = { createTables, runQuery, getQuery };