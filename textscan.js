// textscan.js — Pepe's text scan (1.99xh): the site's cheap content filter (feedfilter.js: its encoded word lists + the
// admins' edits from /feed/admin/filter) run over a line Pepe is about to SPEAK for a user. camfrog-bot's !say moderator
// (pepe_saymod.py) calls it before a !say / -mic reminder / soundboard voice clip is charged, and decides with the room's
// level (off / light / standard / strict) what to refuse - this endpoint only says what the lists see.
//
//   Pepe --POST /api/pepe/textscan {password: bot token, text}--> {ok, hits: [{cat, strength?, scam?}]}
//
// Only categories go back: never the matched words, never list entries (the lists stay where they are). Nothing is
// stored or counted here - Pepe keeps the mod log. Pure + synchronous (feedfilter.scan), typically well under 5 ms.
"use strict";

const MAX_TEXT = 1000;

/** text -> [{cat, strength?, scam?}] - the filter's categories for this text (hate, threats, selfharm, doxxing, spam). */
function scanText(text) {
  const ff = require("./feedfilter");
  const s = String(text == null ? "" : text).slice(0, MAX_TEXT);
  if (!s.trim()) return [];
  return ff.scan(s, { kind: "comment" }).map((h) => {
    const o = { cat: h.cat };
    if (h.strength) o.strength = h.strength;
    if (h.cat === "spam") o.scam = Array.isArray(h.terms) && h.terms.length > 0;
    return o;
  });
}

function register(app, { isBotToken }) {
  app.post("/api/pepe/textscan", (req, res) => {
    const b = req.body || {};
    if (!isBotToken(String(b.password || req.get("x-bot-token") || ""))) return res.status(403).json({ error: "unauthorized" });
    try {
      res.json({ ok: true, hits: scanText(b.text) });
    } catch (e) {
      console.error("[textscan]", e.message);
      res.status(500).json({ ok: false });
    }
  });
}

module.exports = { register, scanText, MAX_TEXT };
