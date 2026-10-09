// dbUtils.js
const sqlite3 = require('sqlite3').verbose();
const sqlitecfg = require('./sqlitecfg');

// Connect to SQLite database
const db = new sqlite3.Database('./myapp.db', (err) => {
    if (err) {
        console.error('Error opening database ' + err.message);
    } else {
        console.log('Database connected.');
    }
});
// 1.99fb: busy_timeout 5 s + WAL + synchronous=NORMAL on this connection (sqlitecfg.js - and why a plain file copy of
// myapp.db is no longer a backup). `ready` resolves with what the connection ended up with.
const ready = sqlitecfg.tune(db, { label: 'dbUtils' });
ready.then((m) => { if (m.journal_mode !== 'memory') console.log(`[sqlite] journal_mode=${m.journal_mode} synchronous=${m.synchronous} busy_timeout=${m.busy_timeout}`); });

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
        camfrogUsername TEXT,
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

    // Roles a user owns (bought in the prize store, or granted by an admin). The site's own
    // record: Discord roles follow from it, and Pepe reads it (High Roller = no blackjack cap).
    db.run(`CREATE TABLE IF NOT EXISTS user_roles (
        userId TEXT NOT NULL,
        role TEXT NOT NULL,
        source TEXT,
        granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (userId, role)
    )`, (err) => {
        if (err) {
            console.log('Error creating table user_roles', err);
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS pending_camfrog_links (
        code TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        camfrogUsername TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(userId)
    )`, (err) => {
        if (err) {
            console.log('Error creating table pending_camfrog_links', err);
        } else {
            console.log('Table pending_camfrog_links created or already exists.');
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
        segment_index INTEGER,
        payout INTEGER,
        jackpot_pct INTEGER,
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

    // Migration for existing DBs: add the server-authoritative spin columns if missing.
    // (ALTER TABLE ADD COLUMN errors "duplicate column name" if it already exists — ignore that.)
    ['segment_index INTEGER', 'payout INTEGER', 'jackpot_pct INTEGER'].forEach((col) => {
        db.run(`ALTER TABLE wheel_spins ADD COLUMN ${col}`, (err) => {
            if (err && !/duplicate column/i.test(err.message)) {
                console.log('wheel_spins migration error:', err.message);
            }
        });
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

        db.run(`
                CREATE TABLE IF NOT EXISTS poker_now_games (
        pokerNowId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        url TEXT NOT NULL,
        blinds TEXT NOT NULL,
        date_created DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId)
    )`, (err) => {
                if (err) {
                    console.log('Error creating table poker_now_games', err);
                } else {
                    console.log('Table poker_now_games created or already exists.');
                }
            });

    db.run(`CREATE TABLE IF NOT EXISTS prizes (
        prizeId TEXT PRIMARY KEY,
        prize TEXT NOT NULL,
        cost INTEGER NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
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

// Utility functions for inserting and updating data. 1.99fb: a statement that still hits SQLITE_BUSY after the 5 s
// busy_timeout is tried again (3 attempts in all, jittered) - a BUSY statement never ran, so a retry is safe.
function runQuery(sql, params = []) {
    return sqlitecfg.withBusyRetry(() => new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ id: this.lastID, changes: this.changes });
            }
        });
    }));
}

function getQuery(sql, params = []) {
    return sqlitecfg.withBusyRetry(() => new Promise((resolve, reject) => {
        db.all(sql, params, (err, results) => {
            if (err) {
                reject(err);
            } else {
                resolve(results);
            }
        });
    }));
}

/** 1.99fb: fold the WAL back into myapp.db every hour (the site process only - index.js calls it). */
function startCheckpoints() {
    return sqlitecfg.startCheckpoints(db, { label: 'myapp.db' });
}

// Close the database connection when the Node.js process terminates. 1.99gd: via shutdown.js, so the site first
// answers its open long-polls (Pepe's /api/pepe/*/pull) instead of cutting them (nginx 502s on every restart).
require('./shutdown').onExit((done) => {
    db.close((err) => {
      if (err) {
        console.error('Error closing the database', err.message);
      }
      console.log('Database connection closed.');
      done();
    });
  });

module.exports = { createTables, runQuery, getQuery, startCheckpoints, ready, db };