// bingo.js — 🎱 the Bingo page (1.99abn). PAT Bingo runs in Pepe (camfrog-bot pepe_bingo.py: the lobby, the cards, the
// caller, the escrow); on every game event he posts a snapshot here (POST /api/bingo/bot, bot token - the same moments
// that drive his OBS overlay). The site keeps the latest one in memory and serves:
//   * GET /bingo             the page: the balls called, the pot, the players, the winners - and YOUR cards (signed in,
//                            your linked Camfrog name) with the called numbers marked and "line ready" / "full card" hints
//   * GET /api/bingo/state   the same for the page's live poll. Nobody else's cards ever leave the server.
// Calling it stays in chat (!bingo) - Pepe checks the cards when you call. A game Pepe stopped telling us about
// (STALE_MS: he restarted - every card is refunded then) shows as "no game"; a finished one stays up for DONE_MS.
"use strict";

const STALE_MS = 10 * 60 * 1000;
const DONE_MS = 30 * 60 * 1000;
const LOGIN_RE = /^[\w.\-$]{1,40}$/;
let clock = () => Date.now();
const now = () => clock();

let SNAP = null;            // {game, at}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d);
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);
function cleanCard(c) {
  if (!Array.isArray(c) || c.length !== 5) return null;
  const out = [];
  for (let i = 0; i < 5; i++) {
    const col = c[i];
    if (!Array.isArray(col) || col.length !== 5) return null;
    out.push(col.map((v, r) => {
      const n = num(v, -1);
      return (i === 2 && r === 2 && n === 0) ? 0 : (n >= i * 15 + 1 && n <= i * 15 + 15 ? n : null);
    }));
    if (out[i].includes(null)) return null;
  }
  return out;
}
/** Pepe's snapshot -> what we keep (validated, bounded). */
function clean(body) {
  const g = body && body.game;
  if (!g || typeof g !== "object") return null;
  const phase = ["lobby", "running", "done", "cancelled"].includes(g.phase) ? g.phase : null;
  if (!phase) return null;
  const pot = g.pot && typeof g.pot === "object" ? g.pot : {};
  const players = (Array.isArray(g.players) ? g.players : []).slice(0, 200).map((p) => ({
    login: str(p && p.login, 40).toLowerCase(), key: str(p && p.key, 40).toLowerCase(), name: str(p && p.name, 40),
    cards: (Array.isArray(p && p.cards) ? p.cards : []).slice(0, 12).map(cleanCard).filter(Boolean),
  }));
  return {
    id: str(g.id, 20), room: str(g.room, 80), phase,
    called: (Array.isArray(g.called) ? g.called : []).map((n) => num(n)).filter((n) => n >= 1 && n <= 75).slice(0, 75),
    pot: { total: num(pot.total), line: num(pot.line), blackout: num(pot.blackout), rollover: num(pot.rollover) },
    price: num(g.price), max_cards: num(g.max_cards), lobby_until: num(g.lobby_until), call_secs: num(g.call_secs),
    line_won: !!g.line_won,
    line_winners: (Array.isArray(g.line_winners) ? g.line_winners : []).slice(0, 20).map((x) => str(x, 40)),
    blackout_winners: (Array.isArray(g.blackout_winners) ? g.blackout_winners : []).slice(0, 20).map((x) => str(x, 40)),
    prizes: g.prizes && typeof g.prizes === "object" ? { line: num(g.prizes.line), blackout: num(g.prizes.blackout) } : null,
    why: str(g.why, 120) || null, last: str(g.last, 40) || null, players,
  };
}
function botPost(body, t = now()) {
  const g = clean(body);
  if (!g) return { ok: false };
  SNAP = { game: g, at: t };
  return { ok: true };
}

// a card against the balls called (the centre is free) - the same rules as Pepe's
function lines(card) {
  const rows = [0, 1, 2, 3, 4].map((r) => card.map((col) => col[r]));
  const diags = [[0, 1, 2, 3, 4].map((i) => card[i][i]), [0, 1, 2, 3, 4].map((i) => card[i][4 - i])];
  return rows.concat(card, diags);
}
const hasLine = (card, called) => lines(card).some((l) => l.every((v) => v === 0 || called.has(v)));
const blackout = (card, called) => card.every((col) => col.every((v) => v === 0 || called.has(v)));

/** The page's view: public game state + `me` (the viewer's own cards) when they're playing. */
function stateFor(login, t = now()) {
  const s = SNAP;
  if (!s) return { game: null };
  const g = s.game;
  const live = g.phase === "lobby" || g.phase === "running";
  if ((live && t - s.at > STALE_MS) || (!live && t - s.at > DONE_MS)) return { game: null };
  let roomName = g.room;
  try { const r = require("./rooms").getCached(g.room); if (r && r.name) roomName = r.name; } catch (e) { /* the id */ }
  const called = new Set(g.called);
  const out = {
    id: g.id, room: roomName, phase: g.phase, called: g.called, last: g.called.length ? g.called[g.called.length - 1] : null,
    pot: g.pot, price: g.price, max_cards: g.max_cards, lobby_until: g.lobby_until, call_secs: g.call_secs, line_won: g.line_won,
    line_winners: g.line_winners, blackout_winners: g.blackout_winners, prizes: g.prizes, why: g.why, updated: s.at,
    players: g.players.map((p) => ({ name: p.name, cards: p.cards.length })), cards_sold: g.players.reduce((n, p) => n + p.cards.length, 0),
  };
  const l = String(login || "").toLowerCase();
  const p = l && LOGIN_RE.test(l) ? g.players.find((x) => x.login === l || x.key === l) : null;
  const me = p ? {
    name: p.name,
    cards: p.cards.map((c) => ({ card: c, line: hasLine(c, called), full: blackout(c, called) })),
  } : null;
  return { game: out, me, linked: !!l };
}

async function loginOf(req) {
  if (!req.user || !req.user.userId) return null;
  if (req.user.camfrogUsername !== undefined) return req.user.camfrogUsername || null;
  try {
    const r = (await require("./dbUtils").getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(req.user.userId)]))[0];
    return r && r.camfrogUsername ? String(r.camfrogUsername) : null;
  } catch (e) { return null; }
}

function register(app, { addUser, isBotToken } = {}) {
  app.post("/api/bingo/bot", (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    if (typeof isBotToken !== "function" || !isBotToken(b.password)) return res.status(403).json({ ok: false });
    res.json(botPost(b));
  });
  app.get("/api/bingo/state", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, signedIn: !!(req.user && req.user.userId), ...stateFor(await loginOf(req)) });
  });
  app.get("/bingo", addUser, async (req, res) => {
    const st = { ok: true, signedIn: !!(req.user && req.user.userId), ...stateFor(await loginOf(req)) };
    res.locals.og = { title: "PAT Bingo - live", description: "Watch the balls come out and follow your cards live. Play in chat with !bingo.",
                      url: (res.locals.ogBase || "") + "/bingo" };
    res.render("bingo", { user: req.user ? req.user.username : null, st });
  });
}

module.exports = { register, botPost, stateFor, clean, hasLine, blackout, STALE_MS, DONE_MS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { SNAP = null; } };
