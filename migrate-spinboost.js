// migrate-spinboost.js — one-off migration for the gold-wheel daily limit + shop boost.
// Adds users.extra_daily_spins and the "+100 Daily Gold Spins" prize. Idempotent (safe to
// re-run). Run from the app directory on the server:  node migrate-spinboost.js
const sqlite3 = require("sqlite3");
const db = new sqlite3.Database("./myapp.db");
require("./sqlitecfg").tune(db, { label: "migrate" });   // 1.99fb: busy_timeout + WAL like the site

function addPrize() {
  db.get("SELECT prizeId FROM prizes WHERE prizeId = 'spinboost100'", (e, row) => {
    if (e) { console.error("prize check error:", e.message); return db.close(); }
    if (row) { console.log("• prize spinboost100 already exists"); return db.close(); }
    db.run(
      "INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES ('spinboost100', '+100 Daily Gold Spins', 3000000, 999999)",
      (er) => {
        console.log(er ? "INSERT error: " + er.message : "• inserted prize spinboost100 (3,000,000 PAT list price; shop.js prices it per buyer, 1.99fj)");
        db.close();
      }
    );
  });
}

db.all("PRAGMA table_info(users)", (e, rows) => {
  if (e) { console.error("pragma error:", e.message); return db.close(); }
  const has = rows.some((r) => r.name === "extra_daily_spins");
  if (has) { console.log("• users.extra_daily_spins already exists"); return addPrize(); }
  db.run("ALTER TABLE users ADD COLUMN extra_daily_spins INTEGER DEFAULT 0", (er) => {
    console.log(er ? "ALTER error: " + er.message : "• added users.extra_daily_spins");
    addPrize();
  });
});
