// migrate-casino-ban.js — adds users.casino_banned (0/1). Idempotent.
// Run from the app directory on the server:  node migrate-casino-ban.js
const sqlite3 = require("sqlite3");
const db = new sqlite3.Database("./myapp.db");

db.all("PRAGMA table_info(users)", (e, rows) => {
  if (e) { console.error("pragma error:", e.message); return db.close(); }
  if (rows.some((r) => r.name === "casino_banned")) {
    console.log("• users.casino_banned already exists");
    return db.close();
  }
  db.run("ALTER TABLE users ADD COLUMN casino_banned INTEGER DEFAULT 0", (er) => {
    console.log(er ? "ALTER error: " + er.message : "• added users.casino_banned");
    db.close();
  });
});
