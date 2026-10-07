// padrules.js — a pad's own rules (1.99dc). The pad owner (or a site admin) writes a short list - up to
// MAX_RULES rules, each a title + an optional description - plus an optional intro. They show on the pad page
// (the collapsible "Rules" card), next to the composer ("Posting in p/x: read the rules") and are what Pepe's
// feed automod judges posts in that pad by (feedautomod.js). A pad with no rules follows the site-wide
// guidelines, Padiquette (guidelines.js, /guidelines), and says so. The site's hard limits (guidelines.ALWAYS:
// CSAM, illegal content, doxxing, threats, NCII, harassment campaigns, impersonation, malware, fraud) hold in
// every pad on top of its own rules.
//
// Stored in feed_kv "rules:<roomId>" = {intro, rules: [{id, title, desc}], updated, by}. Rule ids are "r1".."r15"
// in list order (what the automod cites; a reorder renumbers them - old automod rows keep their rule TITLE).
// Every change is a room_events row ("feed-rules").
"use strict";
const store = require("./feedstore");
const rooms = require("./rooms");
const G = require("./guidelines");

const MAX_RULES = 15, TITLE_MAX = 80, DESC_MAX = 400, INTRO_MAX = 600;
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;
const line = (s, n) => String(s == null ? "" : s).replace(CTRL, "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, n);
const text = (s, n) => String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(CTRL, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/** Any input -> {intro, rules: [{id, title, desc}]} (blank rules dropped, capped, renumbered). */
function clean(input) {
  const x = input && typeof input === "object" ? input : {};
  const list = Array.isArray(x.rules) ? x.rules : [];
  const rules = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const title = line(r.title, TITLE_MAX);
    const desc = text(r.desc != null ? r.desc : r.description, DESC_MAX);
    if (!title && !desc) continue;
    if (!title) throw new Refuse(400, "Every rule needs a short title.");
    if (rules.length >= MAX_RULES) throw new Refuse(400, `A pad can have up to ${MAX_RULES} rules.`);
    rules.push({ id: "r" + (rules.length + 1), title, desc });
  }
  return { intro: text(x.intro, INTRO_MAX), rules };
}

/** The pad's own rules, or null when it has none (it then follows Padiquette). */
async function get(roomId) {
  await store.init();
  let v = null;
  try { v = JSON.parse((await store.kvGet("rules:" + String(roomId || ""))) || "null"); } catch (e) { v = null; }
  if (!v || typeof v !== "object") return null;
  let c;
  try { c = clean(v); } catch (e) { return null; }
  if (!c.rules.length && !c.intro) return null;
  return { ...c, updated: Number(v.updated) || 0, by: v.by ? String(v.by) : null };
}

/**
 * What applies in a pad, for the pad page, the composer and the automod:
 *   {source: "pad" | "site", name, intro, rules: [{id, title, desc}], hard: [site rules that always hold], url}
 * source "site" = no pad rules: rules ARE Padiquette's (all of them, ids = guidelines ids).
 */
async function effective(roomId) {
  const own = roomId ? await get(roomId) : null;
  const hard = G.RULES.filter((r) => G.ALWAYS.includes(r.id)).map((r) => ({ id: r.id, title: r.title, desc: r.desc, severity: r.severity }));
  if (own && own.rules.length) {
    return { source: "pad", name: null, intro: own.intro, rules: own.rules, hard, updated: own.updated, url: G.PATH };
  }
  return { source: "site", name: G.NAME, intro: own ? own.intro : "", rules: G.RULES.map((r) => ({ id: r.id, title: r.title, desc: r.desc, severity: r.severity })),
           hard, updated: 0, url: G.PATH };
}

/** Save a pad's rules (owner or site staff). Empty list + empty intro = back to Padiquette. -> the new rules or null */
async function set(user, roomId, input) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this pad's owner can change its rules.");
  const c = clean(input);
  await store.init();
  if (!c.rules.length && !c.intro) {
    await store.kvSet("rules:" + roomId, "null");
    await rooms.event(roomId, "feed-rules", user.username, "cleared - the pad follows " + G.NAME);
    return null;
  }
  await store.kvSet("rules:" + roomId, JSON.stringify({ ...c, updated: Date.now(), by: user.username }));
  await rooms.event(roomId, "feed-rules", user.username, `${c.rules.length} rule${c.rules.length === 1 ? "" : "s"}: ` + c.rules.map((r) => r.title).join(" | "));
  return get(roomId);
}

function register(app, { addUser }) {
  const json = require("express").json({ limit: "32kb" });
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  app.post("/api/rooms/:slug/rules", addUser, json, async (req, res) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch" || !req.is("application/json")) return res.status(403).json({ ok: false, error: "Bad request." });
    try {
      const R = (await rooms.get(String(req.params.slug || ""))) || (await require("./roomsweb").resolveRoom(String(req.params.slug || "")));
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      const out = await set(req.user, R.id, req.body || {});
      res.json({ ok: true, rules: out, effective: await effective(R.id) });
    } catch (e) {
      const st = e && e.status && e.status < 500 ? e.status : 500;
      if (st === 500) console.error("[padrules]", e);
      res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
    }
  });
  // public: a pad's rules (the composer swaps them when you pick another pad)
  app.get("/api/rooms/:slug/rules", async (req, res) => {
    try {
      const R = (await rooms.get(String(req.params.slug || ""))) || (await require("./roomsweb").resolveRoom(String(req.params.slug || "")));
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, rules: await effective(R.id) });
    } catch (e) { res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
}

module.exports = { register, get, set, effective, clean, MAX_RULES, TITLE_MAX, DESC_MAX, INTRO_MAX, Refuse };
