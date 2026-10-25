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
        avatar TEXT NOT NULL DEFAULT "/public/img/avatar.png",
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

// ── 1.99st: transactions - ONE primitive for the whole site process ──
// Every module shares this ONE connection, and SQLite has one transaction per connection: any statement issued while
// another request's BEGIN is open becomes part of THAT transaction (and is lost if it rolls back), and a second BEGIN
// fails. Prod 2026-10-12: two wheel acknowledges' raw BEGINs collided and a 5,000 debit lost its ledger row. So:
//   * tx(fn) is the only way to open a transaction. One at a time (a global chain), BEGIN IMMEDIATE (retried while
//     another process holds the write lock), COMMIT / ROLLBACK of its OWN transaction only. mainstage._tx, boosts.tx,
//     shop, staleaccounts, escrow, pools, gangs... all delegate here.
//   * the open transaction is carried in AsyncLocalStorage: a tx() inside one (any depth, any module) runs in a
//     SAVEPOINT of it instead of queueing behind it (which deadlocked) or issuing a second BEGIN (which failed);
//     inTx() tells code whether it is inside one (ledger.post wraps itself in tx() when it is not).
//   * the write gate: a write OUTSIDE any transaction (an autocommit runQuery from an unrelated request) waits while
//     one is open - at most GATE_MS, then it runs anyway and is logged - and a transaction waits for writes already
//     on their way before its BEGIN. So no unrelated write lands inside somebody else's transaction. Reads (SELECT /
//     PRAGMA / EXPLAIN) are never held.
// Never runQuery("BEGIN ...") / ("COMMIT") / ("ROLLBACK") yourself (test/tx-global.test.js checks the tree).
const { AsyncLocalStorage } = require('async_hooks');
const txStore = new AsyncLocalStorage();
const GATE_MS = 5000;          // longest an outside write waits for an open transaction (then it runs, [tx] gate timeout)
const SLOW_TX_MS = 1000;       // a transaction held open longer is logged (every outside write waited for it)
const QUEUE_WARN_MS = 15000;   // a tx() still queued after this is logged (a transaction awaiting work that needs the chain?)
let txChain = Promise.resolve();
let txOpen = null;             // the open top-level transaction: { done: Promise, since: ms }
let pending = 0;               // outside writes waiting at the gate or issued and not answered yet
let drainWaiter = null;        // resolves when pending reaches 0 (a transaction waiting to BEGIN)
let spSeq = 0;
const stats = { tx: 0, nested: 0, rolledBack: 0, gated: 0, gateTimeouts: 0, slow: 0 };

const isRead = (sql) => /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(String(sql));
/** the open transaction context this code runs in, if any (a context whose transaction has ended counts as none) */
function current() {
    const c = txStore.getStore();
    return c && c.open && c.root.open ? c : null;
}
const inTx = () => !!current();
const txStats = () => ({ ...stats, open: !!txOpen, pending });

function waitFor(p, ms) {
    let t;
    return Promise.race([p, new Promise((r) => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t));
}
function settled() {
    if (--pending === 0 && drainWaiter) { const r = drainWaiter; drainWaiter = null; r(); }
}

/**
 * Run go() (-> promise) for `sql` under the write gate. An outside write is counted (pending) from the moment it
 * arrives, so the NEXT transaction lets every write that queued behind the last one through before its BEGIN (no
 * starvation behind back-to-back transactions).
 */
function gate(sql, go) {
    if (current() || isRead(sql)) return go();
    pending++;
    if (!txOpen) return go().finally(settled);
    return (async () => {
        stats.gated++;
        const until = Date.now() + GATE_MS;
        while (txOpen && !current()) {
            const left = until - Date.now();
            if (left <= 0) {
                stats.gateTimeouts++;
                console.warn(`[tx] gate timeout: a write waited ${GATE_MS} ms for an open transaction and runs inside it: ${String(sql).replace(/\s+/g, ' ').slice(0, 120)}`);
                break;
            }
            await waitFor(txOpen.done, left);
        }
        return go().finally(settled);
    })();
}

const rawRun = (sql, params) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
    });
});
const rawAll = (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, results) => { if (err) reject(err); else resolve(results); });
});

// Utility functions for inserting and updating data. 1.99fb: a statement that still hits SQLITE_BUSY after the 5 s
// busy_timeout is tried again (3 attempts in all, jittered) - a BUSY statement never ran, so a retry is safe.
// 1.99st: both go through the write gate (above).
function runQuery(sql, params = []) {
    return gate(sql, () => sqlitecfg.withBusyRetry(() => rawRun(sql, params)));
}

function getQuery(sql, params = []) {
    return gate(sql, () => sqlitecfg.withBusyRetry(() => rawAll(sql, params)));
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function begin() {
    for (let i = 0; ; i++) {
        try { await runQuery('BEGIN IMMEDIATE TRANSACTION'); return; } catch (e) {
            if (/within a transaction/i.test(e.message)) {
                console.error('[tx] BEGIN found a transaction already open on the shared connection - a raw BEGIN outside dbUtils.tx()?');
            }
            if (i >= 40 || !/within a transaction|SQLITE_BUSY|locked/i.test(e.message)) throw e;
            await sleepMs(50);
        }
    }
}

async function topLevel(fn) {
    let release;
    const done = new Promise((r) => { release = r; });
    const t0 = Date.now();
    const ctx = { open: true, chain: Promise.resolve() };
    ctx.root = ctx;
    stats.tx++;
    try {
        if (pending > 0) {                  // outside writes that arrived first (or waited for the last transaction)
            const drained = new Promise((r) => { drainWaiter = r; });   // land outside this one, before its BEGIN
            await waitFor(drained, GATE_MS);
            drainWaiter = null;
        }
        txOpen = { done, since: Date.now() };
        return await txStore.run(ctx, async () => {
            await begin();
            try {
                const out = await fn();
                await runQuery('COMMIT');
                return out;
            } catch (e) {
                stats.rolledBack++;
                try { await runQuery('ROLLBACK'); } catch (_) { /* nothing open */ }
                throw e;
            }
        });
    } finally {
        ctx.open = false;
        txOpen = null;
        release();
        const ms = Date.now() - t0;
        if (ms > SLOW_TX_MS) { stats.slow++; console.warn(`[tx] a transaction was open ${ms} ms (outside writes waited for it)`); }
    }
}

async function savepoint(parent, fn) {
    stats.nested++;
    const name = 'tx_sp_' + (++spSeq);
    const child = { open: true, root: parent.root, chain: Promise.resolve() };
    return txStore.run(child, async () => {
        try {
            await runQuery(`SAVEPOINT ${name}`);
            try {
                const out = await fn();
                await runQuery(`RELEASE ${name}`);
                return out;
            } catch (e) {
                try { await runQuery(`ROLLBACK TO ${name}`); await runQuery(`RELEASE ${name}`); } catch (_) { /* the outer one rolls back */ }
                throw e;
            }
        } finally { child.open = false; }
    });
}

/**
 * Run fn (-> promise) in a transaction: committed when it resolves, rolled back when it throws; resolves / rejects
 * with fn's outcome. Inside another tx() it is a savepoint of that one (a throw undoes only its own writes).
 */
function tx(fn) {
    const ctx = current();
    if (ctx) {
        const run = ctx.chain.then(() => savepoint(ctx, fn), () => savepoint(ctx, fn));
        ctx.chain = run.catch(() => {});
        return run;
    }
    const queued = Date.now();
    const warn = setTimeout(() => console.warn(`[tx] a transaction has waited ${Date.now() - queued} ms for the chain - is an open one awaiting work that needs a transaction outside its context?`), QUEUE_WARN_MS);
    if (warn.unref) warn.unref();
    const go = () => { clearTimeout(warn); return topLevel(fn); };
    const run = txChain.then(go, go);
    txChain = run.catch(() => {});
    return run;
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

module.exports = { createTables, runQuery, getQuery, tx, inTx, txStats, startCheckpoints, ready, db };