// gtf.js — "Grand Theft Frogger" (GTF), the crime game that ties Pepe's heists, turf wars and gangs
// together. Pepe registers each player's heist sheet here when he publishes it, so a PATV profile
// can link it; /gtf is the overview page linking the guides and the live boards. The turf map's
// districts change from season to season, so nothing here names them.
const { runQuery, getQuery } = require("./dbUtils");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS heist_sheets (
  camfrog TEXT PRIMARY KEY, display TEXT, url TEXT NOT NULL, cls TEXT, updated INTEGER)`).catch(() => {});

const LINKS = {
  heistHelp: "/help#cat-heists",
  turfHelp: "/help#cat-heists",
  turfGuide: "https://pepe.publicaccess.tv/turfwars",
  turfMap: "https://pepe.publicaccess.tv/turf",
  gangs: "https://pepe.publicaccess.tv/gangs",
  heistBoard: "https://pepe.publicaccess.tv/heist",
};

// ── 1.99nk: the heist minimap (/gtf) - Pepe pushes the live state of every job's target (cooldown, vault, last hit,
// heat, the heist running now) to POST /api/gtf/bot/board about once a minute and on every change while a heist runs;
// the page reads GET /api/gtf/board. Display only - nothing here decides anything. ──
const boardReady = ready.then(() => runQuery(`CREATE TABLE IF NOT EXISTS gtf_board (id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL, updated INTEGER NOT NULL)`)).catch(() => {});
let boardCache = null;          // {board, at}
const BOARD_STALE_MS = 5 * 60e3;
const OUTCOMES = new Set(["cracked", "taken", "getaway", "door", "busted", "bailed"]);
const str = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f]/g, " ").slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);

/** Pepe's board -> the shape the page trusts (anything unexpected dropped). */
function cleanBoard(b) {
  if (!b || typeof b !== "object") return null;
  const jobs = (Array.isArray(b.jobs) ? b.jobs : []).slice(0, 8).map((j) => {
    if (!j || !/^[a-z]{2,16}$/.test(String(j.job || ""))) return null;
    const v = j.vault && typeof j.vault === "object" ? { name: str(j.vault.name, 40), emoji: str(j.vault.emoji, 8), balance: num(j.vault.balance) } : null;
    const l = j.last && typeof j.last === "object" && OUTCOMES.has(j.last.outcome)
      ? { at: num(j.last.at), outcome: j.last.outcome, amount: num(j.last.amount), crew: num(j.last.crew) } : null;
    const c = j.convoy && typeof j.convoy === "object" ? { cargo: num(j.convoy.cargo), until: num(j.convoy.until), gang: str(j.convoy.gang, 8) } : null;
    return { job: j.job, name: str(j.name, 40) || j.job, emoji: str(j.emoji, 8) || "💰", buyin: num(j.buyin), rounds: num(j.rounds),
             heat: num(j.heat), cooldown: num(j.cooldown), ready_at: num(j.ready_at), vault: v, min_vault: num(j.min_vault),
             door_dc: j.door_dc == null ? null : num(j.door_dc), prereq: str(j.prereq, 20), open: !!j.open,
             why: str(j.why, 20), last: l, convoy: c };
  }).filter(Boolean);
  const r = b.running && typeof b.running === "object" && /^[a-z]{2,16}$/.test(String(b.running.job || ""))
    ? { job: b.running.job, phase: b.running.phase === "running" ? "running" : "lobby", round: num(b.running.round),
        rounds: num(b.running.rounds), crew: num(b.running.crew), room: str(b.running.room, 60), since: num(b.running.since) } : null;
  return { jobs, running: r, enabled: b.enabled !== false, heat_max: num(b.heat_max) || 100 };
}

async function readBoard() {
  if (boardCache) return boardCache;
  await boardReady;
  const r = (await getQuery("SELECT data, updated FROM gtf_board WHERE id = 1").catch(() => []))[0];
  if (r) {
    try { boardCache = { board: JSON.parse(r.data), at: r.updated }; } catch (e) { boardCache = null; }
  }
  return boardCache;
}
async function boardView() {
  const c = await readBoard();
  if (!c) return { ok: true, board: null, at: null, stale: true, now: Date.now() };
  return { ok: true, board: c.board, at: c.at, stale: Date.now() - c.at > BOARD_STALE_MS, now: Date.now() };
}

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

  app.post("/api/gtf/bot/board", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    const board = cleanBoard(b.board);
    if (!board) return res.status(400).json({ ok: false, error: "board required" });
    const at = Date.now();
    boardCache = { board, at };
    await boardReady;
    await runQuery(`INSERT INTO gtf_board (id, data, updated) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data,
                    updated = excluded.updated`, [JSON.stringify(board), at]).catch((e) => console.error("[gtf] board:", e.message));
    res.json({ ok: true });
  });
  app.get("/api/gtf/board", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await boardView());
  });

  app.get("/pondlife", (req, res) => res.redirect(301, "/gtf"));
  app.get("/gtf", addUser, async (req, res) => {
    let sheet = null;
    if (req.user && req.user.userId) {
      const u = await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [req.user.userId]);
      sheet = u.length ? await sheetFor(u[0].camfrogUsername) : null;
    }
    let board = null;
    try { board = await boardView(); } catch (e) { board = null; }
    res.render("gtf", { user: req.user ? req.user.username : null, links: LINKS, sheet, board });
  });
}

module.exports = { register, sheetFor, LINKS, cleanBoard, boardView, _resetBoard: () => { boardCache = null; } };
