// gtf.js — "Grand Theft Frogger" (GTF), the crime game that ties Pepe's heists, turf wars and gangs
// together. Pepe registers each player's heist sheet here when he publishes it, so a PATV profile
// can link it; /gtf is the overview page linking the guides and the live boards. The turf map's
// districts change from season to season, so nothing here names them.
const { runQuery, getQuery } = require("./dbUtils");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS heist_sheets (
  camfrog TEXT PRIMARY KEY, display TEXT, url TEXT NOT NULL, cls TEXT, updated INTEGER)`).catch(() => {});

const LINKS = {
  heistHelp: "https://pepe.publicaccess.tv/help#games",
  turfHelp: "https://pepe.publicaccess.tv/help#turf",
  turfGuide: "https://pepe.publicaccess.tv/turfwars",
  turfMap: "https://pepe.publicaccess.tv/turf",
  gangs: "https://pepe.publicaccess.tv/gangs",
  heistBoard: "https://pepe.publicaccess.tv/heist",
};

async function sheetFor(camfrogName) {
  if (!camfrogName) return null;
  await ready;
  const r = await getQuery("SELECT url, cls FROM heist_sheets WHERE camfrog = LOWER(?)", [String(camfrogName)]);
  return r.length ? r[0] : null;
}

function register(app, { isBotToken, addUser }) {
  app.post("/api/heist/sheet", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    const camfrog = String(b.camfrog || "").trim().toLowerCase();
    const url = String(b.url || "");
    if (!camfrog || !/^https:\/\/pepe\.publicaccess\.tv\/sheet\/[a-z0-9_-]+$/i.test(url)) {
      return res.status(400).json({ success: false, error: "camfrog and a pepe.publicaccess.tv/sheet URL required" });
    }
    await ready;
    await runQuery(`INSERT INTO heist_sheets (camfrog, display, url, cls, updated) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(camfrog) DO UPDATE SET display = excluded.display, url = excluded.url,
                    cls = excluded.cls, updated = excluded.updated`,
      [camfrog, String(b.display || "").slice(0, 60), url, String(b.cls || "").slice(0, 30), Date.now()]);
    res.json({ success: true });
  });

  app.get("/pondlife", (req, res) => res.redirect(301, "/gtf"));
  app.get("/gtf", addUser, async (req, res) => {
    let sheet = null;
    if (req.user && req.user.userId) {
      const u = await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [req.user.userId]);
      sheet = u.length ? await sheetFor(u[0].camfrogUsername) : null;
    }
    res.render("gtf", { user: req.user ? req.user.username : null, links: LINKS, sheet });
  });
}

module.exports = { register, sheetFor, LINKS };
