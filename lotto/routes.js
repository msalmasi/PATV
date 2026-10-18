// lotto/routes.js — Pepeball's HTTP API (1.99ml; docs/lotto-backend.md).
//
// Web (a signed-in PATV account - no Camfrog link needed):
//   GET  /api/lotto/state                 the draw, jackpot, schedule, commitment + your ticket count
//   POST /api/lotto/buy                   {picks: [[[w1..w4], pb], ...]} | {quick: n}, idem, confirm   (JSON fetch)
//                                         1.99nh: a hand pick already held this draw -> 409 {code: "dup", dups} unless confirm
//   (the /lotto page's forms still post to /act - actions.js hands cmd=lotto straight to buyFromForm() while the backend is on)
//   GET  /lotto/fair/:draw + /api/lotto/fair/:draw    the fairness proof of a draw (commitment, digest, tickets, seed)
//   POST /api/lotto/admin/settings        {key, value}  lotto_backend / price / pot_share (site Admin, or the bot token)
// Pepe (bot token in the body):
//   POST /api/lotto/bot/poll              {after, wait}  events (sale / milestone / closing / closed / drawn / paid / open) + state
//   POST /api/lotto/bot/act               {username, camfrog, name, verb, args, idem, admin, channel}
//                                         1.99nh: a buy repeating a held ticket still sells; the result adds dups + note
//   POST /api/lotto/bot/pot               {amount, ref, why}   + / - the jackpot pot, keyed (his "lotto" vault is this pot)
//   POST /api/lotto/bot/state             the pot / jackpot / draw (his _vault_total("lotto"))
//   POST /api/lotto/bot/reseeded          {draw, amount}   the reseed after a jackpot is done
//   POST /api/lotto/admin/import          {export, key, enable}  the cutover (bot token)
//   POST /api/lotto/admin/export          the rollback (bot token)
"use strict";
const path = require("path");
const { getQuery } = require("../dbUtils");
const SP = require("../siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const svc = require("./service");
const E = require("./engine");

const IDEM = /^[\w:.\-]{8,100}$/;
const isJsonFetch = (req) => req.is("application/json") && req.get("X-Requested-With") === "fetch";

const MSG = {
  off: "Pepeball is offline right now - try again in a bit.",
  no_account: "Couldn't find your account.",
  banned: "You're banned from the casino.",
  closed: "Ticket sales are closed for this draw — they reopen right after it.",
  bad_pick: "Pick 4 different numbers from 1-30 and a Pepe Ball from 1-10.",
  insufficient: "You don't have enough PAT for that.",
  charge_failed: "Couldn't take the PAT — nothing was bought.",
  dup: "You already have this exact ticket for this draw — buy it again? Nothing was charged; confirm to buy it.",
};
// 1.99nh: the question when a hand pick repeats a ticket the buyer holds
const dupAsk = (draw) => `You already have this exact ticket for draw #${draw} — buy it again?`;

function parsePicks(b) {
  if (Array.isArray(b.picks) && b.picks.length) {
    return b.picks.slice(0, E.RULES.MAX_PER_BUY).map((p) => (Array.isArray(p) ? [Array.isArray(p[0]) ? p[0].slice(0, 4).map((n) => Math.trunc(Number(n))) : [], Math.trunc(Number(p[1]))] : [[], 0]));
  }
  return null;
}

async function webActor(req) {
  if (!req.user || !req.user.userId) return null;
  const u = (await getQuery("SELECT userId, username, displayname, camfrogUsername, class FROM users WHERE userId = ?", [req.user.userId]))[0];
  if (!u) return null;
  return { uid: u.userId, name: u.camfrogUsername || u.displayname || u.username, via: "web", admin: SP.can(u, "escrow.override") };
}

/**
 * actions.js: a /lotto form post (kind=cmd, cmd=lotto, a0.. = the !lotto words) while the backend is on. -> message text,
 * or (1.99nh) {msg, confirm: {draw, w, pb}} when a hand pick repeats a ticket the buyer already holds and the post had no
 * confirm=1 - nothing is charged; the page asks and re-posts with confirm.
 */
async function buyFromForm(userId, words, idem, { confirm = false } = {}) {
  await svc.boot();
  const st = await svc.loadSettings();
  if (!st.lotto_backend) return null;                           // not ours: the action queue sends it to Pepe as before
  const u = (await getQuery("SELECT userId, username, displayname, camfrogUsername FROM users WHERE userId = ?", [userId]))[0];
  if (!u) return MSG.no_account;
  const w = words.map((x) => String(x).toLowerCase());
  let order;
  if (w[0] === "quick" || w[0] === "qp" || w[0] === "quickpick") order = { quick: Math.trunc(Number(w[1]) || 1) };
  else {
    const nums = (w.join(" ").match(/\d+/g) || []).map(Number);
    if (nums.length !== 5) return MSG.bad_pick;
    order = { picks: [[nums.slice(0, 4), nums[4]]] };
  }
  const key = `lt:web-${u.userId}-${IDEM.test(String(idem || "")) ? idem : require("crypto").randomBytes(8).toString("hex")}`;
  const out = await svc.buy({ uid: u.userId, name: u.camfrogUsername || u.displayname || u.username, via: "web" }, order, key,
                            { confirmDup: true, confirm: !!confirm });
  if (!out.ok && out.code === "dup" && out.dups && out.dups.length) {
    return { msg: dupAsk(out.draw), confirm: { draw: out.draw, w: out.dups[0].w, pb: out.dups[0].pb } };
  }
  if (!out.ok) return MSG[out.code] || "Something went wrong — nothing was bought.";
  return `🎟️ ${out.count} ticket${out.count === 1 ? "" : "s"} bought (PAT ${out.cost.toLocaleString("en-US")}) — you hold ${out.mine} for draw #${out.draw}. Good luck!`
    + (out.note ? ` (${out.note})` : "") + (out.replay ? " (already done — not bought twice)" : "");
}

function register(app, { isBotToken, addUser, updateLevel }) {
  if (updateLevel) svc._S.hooks.updateLevel = updateLevel;
  setImmediate(() => svc.boot().catch((e) => console.error("[lotto] boot:", e.message)));

  // ── web ──
  app.get("/api/lotto/state", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try { res.json(Object.assign({ ok: true }, await svc.info(req.user && req.user.userId))); }
    catch (e) { console.error("[lotto] state:", e.message); res.status(500).json({ ok: false }); }
  });

  app.post("/api/lotto/buy", addUser, async (req, res) => {
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const actor = await webActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: "Sign in to play." });
    const b = req.body || {};
    const idem = String(b.idem || "");
    if (!IDEM.test(idem)) return res.status(400).json({ ok: false, error: "Bad request." });
    if (!svc.ipRateOk(actor.uid)) return res.status(429).json({ ok: false, error: "Slow down a little." });
    await svc.boot();
    const picks = parsePicks(b);
    // 1.99nh: hand picks the buyer already holds this draw need {confirm: true} (409 code "dup" + the question otherwise)
    const out = await svc.buy(actor, picks ? { picks } : { quick: b.quick }, `lt:web-${actor.uid}-${idem}`,
                              { confirmDup: true, confirm: b.confirm === true || b.confirm === 1 || b.confirm === "1" });
    const error = out.ok ? null : out.code === "dup" ? dupAsk(out.draw) : MSG[out.code] || "Something went wrong.";
    if (out.ok && !out.replay) require("../streaks").note(actor.uid, "game");   // 1.99xi: 🔥 a Pepeball ticket keeps the daily streak
    res.status(out.ok ? 200 : 409).json(Object.assign({ error }, out));
  });

  app.get("/api/lotto/fair/:draw", async (req, res) => {
    const rec = await svc.fairRecord(req.params.draw).catch(() => null);
    if (!rec) return res.status(404).json({ ok: false, error: "No such draw." });
    res.json(Object.assign({ ok: true }, rec));
  });
  app.get("/lotto/fair/:draw", addUser, (req, res) => {
    res.render("lotto-fair", { user: req.user ? req.user.username : null, draw: Math.trunc(Number(req.params.draw) || 0), title: "Pepeball fairness" });
  });

  app.post("/api/lotto/admin/settings", addUser, async (req, res) => {
    const b = req.body || {};
    let actor = null;
    if (isBotToken(b.password)) actor = "pepe:" + String(b.actor || "bot").slice(0, 40);
    else if (isJsonFetch(req) && req.user && req.user.userId) {
      const u = (await getQuery("SELECT username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (SP.can(u, "casino.admin")) actor = u.username;
    }
    if (!actor) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json({ ok: true, settings: await svc.setSetting(String(b.key || ""), b.value, actor) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ── Pepe ──
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { await svc.boot(); res.json(await fn(b)); }
    catch (e) { console.error(`[lotto] ${req.path}:`, e.message); res.status(500).json({ ok: false, error: "failed" }); }
  };
  app.post("/api/lotto/bot/poll", bot(async (b) => Object.assign({ ok: true }, await svc.poll(b.after, Math.max(0, Math.min(8, Number(b.wait) || 0)) * 1000))));
  app.post("/api/lotto/bot/state", bot(async () => Object.assign({ ok: true }, await svc.info(null))));
  app.post("/api/lotto/bot/pot", bot(async (b) => {
    if (!IDEM.test(String(b.ref || ""))) return { ok: false, error: "ref required" };
    return svc.botPot(b.amount, b.ref, b.why);
  }));
  app.post("/api/lotto/bot/reseeded", bot(async (b) => svc.botReseeded(b.draw, b.amount)));
  app.post("/api/lotto/admin/import", bot(async (b) => svc.importState(b.export, b.key, { enable: !!b.enable, actor: "pepe:" + String(b.actor || "cutover").slice(0, 40) })));
  app.post("/api/lotto/admin/export", bot(async () => svc.exportState()));

  app.post("/api/lotto/bot/act", bot(async (b) => {
    if (String(b.channel || "") === "telegram") return { ok: false, code: "telegram" };
    const verb = String(b.verb || "").toLowerCase();
    const u = (await getQuery("SELECT userId, username, displayname, camfrogUsername FROM users WHERE LOWER(username) = LOWER(?)", [String(b.username || "")]))[0]
      || (b.username ? await require("../usernames").findUser(b.username, { cols: "userId, username, displayname, camfrogUsername" }) : null);
    if (verb === "draw") {
      if (!b.admin) return { ok: false, code: "admin" };
      return svc.forceDraw(String(b.name || b.camfrog || "admin").slice(0, 40));
    }
    if (verb === "info") return Object.assign({ ok: true }, await svc.info(u ? u.userId : null));
    if (verb === "results") return { ok: true, last: (await svc.history(1))[0] || null, state: await svc.info(null) };
    if (!u) return { ok: false, code: "no_account" };
    if (verb === "tickets") return Object.assign({ ok: true }, await svc.myTickets(u.userId));
    if (verb === "buy" || verb === "quick") {
      const idem = String(b.idem || "");
      if (!IDEM.test(idem)) return { ok: false, code: "bad_request" };
      const name = String(b.camfrog || b.name || u.camfrogUsername || u.username).replace(/[\u0000-\u001f]/g, " ").slice(0, 40);
      const order = verb === "quick" ? { quick: Math.trunc(Number((b.args || [])[0]) || 1) } : { picks: parsePicks({ picks: b.picks }) || [] };
      if (verb === "buy" && !order.picks.length) return { ok: false, code: "bad_pick" };
      // 1.99nh: a repeat of a held ticket is still sold from chat; the reply carries `note` (+ dups) for Pepe to append
      return svc.buy({ uid: u.userId, name, via: "room" }, order, `lt:cf-${idem}`);
    }
    return { ok: false, code: "bad_verb" };
  }));
}

module.exports = { register, buyFromForm, MSG, dupAsk, _views: path.join(__dirname, "..", "views") };
