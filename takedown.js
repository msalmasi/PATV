// takedown.js — the TAKE IT DOWN Act notice-and-removal process (1.99pv, PATV Creators P0): non-consensual intimate imagery
// (NCII, including AI-made "digital forgeries") reported by the person shown (or someone authorised to act for them) is
// removed within 48 HOURS of a valid request, and known identical copies with it.
//
//   GET  /takedown                 the public request form (no account needed - the law covers non-members)
//   POST /api/takedown             a request: name, email, relationship (self | authorized), the links, a description, the
//                                  good-faith statement and an electronic signature. Rate-limited per IP / account.
//   a feed report with reason "ncii" (feedstore.report) opens a case too (source "report").
//   GET  /admin/takedowns          the queue (Admins + Staff): the 48 h countdown per case, the content, Remove / Reject / Need info
//
// What happens on a request: a case with deadline = received + 48 h; every listed post is HIDDEN at once pending review
// (autohide, reversible - staff restore it on Reject); every admin gets an urgent inbox notice; the hourly job reminds the
// staff at 24 h and 8 h left. Remove: each post is deleted by staff ("TAKE IT DOWN (NCII)"), every unreleased PATV Creators
// purchase of it refunded (feedstore.remove's hook), and the sha256 of each of its files goes on the block list: an exact
// copy is refused at posting (feedstore.create -> blockedFiles) and existing exact copies are removed with the case.
// Perceptual / near-duplicate matching is a vendor item (the explicit-tier checklist).
//
//   takedown_cases   id, created, deadline, status open|removed|rejected|need_info, source form|report, requester_name, email,
//                    relationship, urls (JSON), posts (JSON ids), description, signature, reporter_id, ip_hash, autohidden (JSON),
//                    reminded, resolved_at, resolved_by, note, removed (JSON)
//   takedown_hashes  sha256 PRIMARY KEY, case_id, created
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const SLA_MS = 48 * 3600 * 1000;
const PER_IP_DAY = 5, PER_USER_DAY = 5;
let clock = () => Date.now();
const now = () => clock();
class Refuse extends Error { constructor(status, message) { super(message); this.status = status; this.refuse = true; } }
const cleanLine = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const cleanText = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, n);
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,24}$/;

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS takedown_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, deadline INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL, requester_name TEXT, email TEXT, relationship TEXT, urls TEXT, posts TEXT, description TEXT,
        signature TEXT, reporter_id TEXT, ip_hash TEXT, autohidden TEXT, reminded INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER, resolved_by TEXT, note TEXT, removed TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS takedown_cases_open ON takedown_cases (status, deadline)");
      await runQuery("CREATE TABLE IF NOT EXISTS takedown_hashes (sha256 TEXT PRIMARY KEY, case_id INTEGER, created INTEGER NOT NULL)");
      HASHES = Number((await getQuery("SELECT COUNT(*) AS n FROM takedown_hashes"))[0].n) || 0;
    })().catch((e) => { ready = null; console.error("[takedown] init:", e.message); throw e; });
  }
  return ready;
}
let HASHES = 0;

/** Post ids named by the links: /p/<pad>/posts/<id>, /u/<u>/posts/<id>, /feed/p/<id>, /media/f/<file> (its post). */
async function postsFromUrls(text) {
  const ids = new Set();
  const lines = String(text || "").split(/[\s,]+/).filter(Boolean).slice(0, 20);
  for (const l of lines) {
    let m = /\/posts\/([A-Za-z0-9]{8,16})(?:[/?#]|$)/.exec(l) || /\/feed\/p\/([A-Za-z0-9]{8,16})(?:[/?#]|$)/.exec(l);
    if (m) { ids.add(m[1]); continue; }
    m = /\/(?:media|feed)\/f\/([a-f0-9]{32}(?:_t|_p)?\.(?:webp|m4a|mp4))/.exec(l);
    if (m) {
      const a = (await getQuery("SELECT post_id FROM feed_attachments WHERE (file = ? OR thumb = ? OR poster = ?) AND post_id IS NOT NULL LIMIT 1", [m[1], m[1], m[1]]).catch(() => []))[0];
      if (a) ids.add(a.post_id);
    }
  }
  const out = [];
  for (const id of ids) if ((await getQuery("SELECT 1 AS x FROM feed_posts WHERE id = ?", [id]).catch(() => [])).length) out.push(id);
  return out;
}
async function hidePosts(ids) {
  const done = [];
  for (const id of ids) {
    const r = await runQuery("UPDATE feed_posts SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL AND deleted_at IS NULL", [now(), id]).catch(() => ({ changes: 0 }));
    if (r.changes) done.push(id);
    await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND sent_at IS NULL", [id]).catch(() => {});
  }
  return done;
}
async function alertStaff(id, title, body) {
  const staff = await getQuery("SELECT userId FROM users WHERE class IN ('Admin', 'Staff')").catch(() => []);
  for (const s of staff) {
    await require("./inbox").addSafe(s.userId, { kind: "admin", title, body, link: "/admin/takedowns#c" + id, ref: `takedown:${id}:${title.slice(0, 20)}` });
  }
}
const ipHash = (ip) => crypto.createHash("sha256").update("takedown:" + String(ip || "")).digest("hex").slice(0, 24);

/** A request from the public form. -> {ok, id, deadline} */
async function request(input = {}, { user = null, ip = "" } = {}) {
  await init();
  const name = cleanLine(input.name, 120);
  const email = cleanLine(input.email, 254);
  const rel = input.relationship === "authorized" ? "authorized" : input.relationship === "self" ? "self" : null;
  const urls = cleanText(input.urls, 4000);
  const desc = cleanText(input.description, 3000);
  const sig = cleanLine(input.signature, 120);
  const yes = (v) => v === true || v === "1" || v === "on" || v === 1;
  if (!name) throw new Refuse(400, "Your name is required.");
  if (!EMAIL_RE.test(email)) throw new Refuse(400, "A contact email is required.");
  if (!rel) throw new Refuse(400, "Say whether you're the person shown or authorised to act for them.");
  if (!urls) throw new Refuse(400, "Add the link(s) to the content.");
  if (!yes(input.good_faith)) throw new Refuse(400, "Tick the good-faith statement.");
  if (!sig) throw new Refuse(400, "Type your name as your electronic signature.");
  const t = now();
  const ih = ipHash(ip);
  const byIp = Number((await getQuery("SELECT COUNT(*) AS n FROM takedown_cases WHERE ip_hash = ? AND created > ?", [ih, t - 24 * 3600e3]))[0].n);
  if (byIp >= PER_IP_DAY) throw new Refuse(429, "Too many requests from here today - email abuse@publicaccess.tv instead.");
  if (user && user.userId) {
    const byU = Number((await getQuery("SELECT COUNT(*) AS n FROM takedown_cases WHERE reporter_id = ? AND created > ?", [user.userId, t - 24 * 3600e3]))[0].n);
    if (byU >= PER_USER_DAY) throw new Refuse(429, "Too many requests today - email abuse@publicaccess.tv instead.");
  }
  const posts = await postsFromUrls(urls);
  const hidden = await hidePosts(posts);
  const ins = await runQuery(`INSERT INTO takedown_cases (created, deadline, status, source, requester_name, email, relationship, urls, posts, description, signature, reporter_id, ip_hash, autohidden)
                              VALUES (?, ?, 'open', 'form', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                             [t, t + SLA_MS, name, email, rel, JSON.stringify(urls.split(/\s+/).filter(Boolean).slice(0, 20)), JSON.stringify(posts), desc || null, sig,
                              user && user.userId ? user.userId : null, ih, JSON.stringify(hidden)]);
  await alertStaff(ins.id, `URGENT: TAKE IT DOWN request #${ins.id} - remove within 48 h`,
                   `${posts.length} post(s) found from the links, ${hidden.length} hidden pending review. Deadline ${new Date(t + SLA_MS).toISOString().replace("T", " ").slice(0, 16)} UTC.`);
  console.error(`[takedown] request #${ins.id}: ${posts.length} post(s), ${hidden.length} hidden pending review`);
  return { ok: true, id: ins.id, deadline: t + SLA_MS, found: posts.length };
}
/** feedstore.report's hook: a member reported a post as NCII. hide = the reporter is trusted (not paused). */
async function fromReport(postId, reporterId, note, { hide = true } = {}) {
  try {
    await init();
    const open = (await getQuery("SELECT id FROM takedown_cases WHERE status IN ('open','need_info') AND posts LIKE ? LIMIT 1", ['%"' + String(postId) + '"%']))[0];
    if (open) return open.id;
    const t = now();
    const hidden = hide ? await hidePosts([String(postId)]) : [];
    const ins = await runQuery(`INSERT INTO takedown_cases (created, deadline, status, source, posts, description, reporter_id, autohidden) VALUES (?, ?, 'open', 'report', ?, ?, ?, ?)`,
                               [t, t + SLA_MS, JSON.stringify([String(postId)]), cleanText(note, 1000) || null, reporterId || null, JSON.stringify(hidden)]);
    await alertStaff(ins.id, `URGENT: NCII report #${ins.id} - TAKE IT DOWN 48 h clock`, `A post was reported as non-consensual intimate imagery${hidden.length ? " (hidden pending review)" : ""}.`);
    return ins.id;
  } catch (e) { console.error("[takedown] fromReport:", e.message); return null; }
}

async function fileHash(name) {
  const p = require("./feedmedia").filePath(name);
  if (!p || !fs.existsSync(p)) return null;
  return new Promise((res) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(p).on("data", (d) => h.update(d)).on("error", () => res(null)).on("end", () => res(h.digest("hex")));
  });
}
/** feedstore.create's hook: refuse a post whose files are exact copies of removed NCII. -> null | refusal message */
async function blockedFiles(atts) {
  await init();
  if (!HASHES || !atts || !atts.length) return null;
  for (const a of atts) {
    if (!a.file) continue;
    const h = await fileHash(a.file);
    if (h && (await getQuery("SELECT 1 AS x FROM takedown_hashes WHERE sha256 = ?", [h])).length) {
      console.error(`[takedown] blocked a re-upload of removed content (attachment ${a.id})`);
      return "That file was removed under our non-consensual imagery policy and can't be posted again.";
    }
  }
  return null;
}

async function mustStaff(actor) {
  if (!SP.can(actor, "takedown.handle")) throw new Refuse(403, "Staff only.");   // 1.99ack: takedown.handle (locked: Staff and up)
}
/** Remove: delete every post of the case (and every post holding an exact copy of their files), block the hashes. */
async function remove(actor, id, note) {
  await init(); await mustStaff(actor);
  const c = (await getQuery("SELECT * FROM takedown_cases WHERE id = ?", [Number(id) || 0]))[0];
  if (!c) throw new Refuse(404, "No such case.");
  if (c.status === "removed") throw new Refuse(409, "Already removed.");
  const store = require("./feedstore");
  const posts = new Set(JSON.parse(c.posts || "[]"));
  const hashes = new Set();
  for (const pid of posts) {
    for (const a of await getQuery("SELECT file, poster FROM feed_attachments WHERE post_id = ? AND kind IN ('image','video','audio')", [pid])) {
      const h = await fileHash(a.file); if (h) hashes.add(h);
    }
  }
  // known identical copies: other posts with a file of the same sha256 (exact copies only)
  if (hashes.size) {
    const cands = await getQuery(`SELECT a.post_id, a.file FROM feed_attachments a JOIN feed_posts p ON p.id = a.post_id WHERE a.kind IN ('image','video') AND a.state = 'ready'
                                  AND p.deleted_at IS NULL ORDER BY a.created DESC LIMIT 5000`);
    for (const x of cands) {
      if (posts.has(x.post_id)) continue;
      const h = await fileHash(x.file);
      if (h && hashes.has(h)) posts.add(x.post_id);
    }
  }
  const removed = [];
  const why = "TAKE IT DOWN (non-consensual intimate imagery)";
  for (const pid of posts) {
    try { await store.remove(actor, pid, why); removed.push(pid); } catch (e) { if (!/No such post/.test(e.message)) console.error("[takedown] remove", pid, e.message); }
  }
  const t = now();
  for (const h of hashes) await runQuery("INSERT OR IGNORE INTO takedown_hashes (sha256, case_id, created) VALUES (?, ?, ?)", [h, c.id, t]);
  HASHES = Number((await getQuery("SELECT COUNT(*) AS n FROM takedown_hashes"))[0].n) || 0;
  await runQuery("UPDATE takedown_cases SET status = 'removed', resolved_at = ?, resolved_by = ?, note = ?, removed = ? WHERE id = ?",
                 [t, actor.username, cleanLine(note, 500) || null, JSON.stringify(removed), c.id]);
  const late = t > Number(c.deadline);
  console.log(`[takedown] case #${c.id} removed by ${actor.username}: ${removed.length} post(s), ${hashes.size} hash(es) blocked${late ? " - AFTER the 48 h deadline" : ""}`);
  return { ok: true, removed: removed.length, hashes: hashes.size, late };
}
async function reject(actor, id, note) {
  await init(); await mustStaff(actor);
  const c = (await getQuery("SELECT * FROM takedown_cases WHERE id = ?", [Number(id) || 0]))[0];
  if (!c) throw new Refuse(404, "No such case.");
  if (c.status === "removed" || c.status === "rejected") throw new Refuse(409, "Already decided.");
  if (!cleanLine(note, 500)) throw new Refuse(400, "Say why (it's kept with the case).");
  for (const pid of JSON.parse(c.autohidden || "[]")) await runQuery("UPDATE feed_posts SET hidden_at = NULL WHERE id = ? AND deleted_at IS NULL", [pid]);
  await runQuery("UPDATE takedown_cases SET status = 'rejected', resolved_at = ?, resolved_by = ?, note = ? WHERE id = ?", [now(), actor.username, cleanLine(note, 500), c.id]);
  return { ok: true };
}
async function needInfo(actor, id, note) {
  await init(); await mustStaff(actor);
  const r = await runQuery("UPDATE takedown_cases SET status = 'need_info', note = ? WHERE id = ? AND status IN ('open','need_info')", [cleanLine(note, 500) || null, Number(id) || 0]);
  if (!r.changes) throw new Refuse(409, "Not open.");
  return { ok: true };
}
async function queue() {
  await init();
  const rows = await getQuery("SELECT * FROM takedown_cases ORDER BY CASE WHEN status IN ('open','need_info') THEN 0 ELSE 1 END, deadline, id DESC LIMIT 200");
  const t = now();
  const out = [];
  for (const r of rows) {
    const posts = JSON.parse(r.posts || "[]");
    const links = [];
    for (const pid of posts) { try { links.push({ id: pid, url: await require("./feedstore").postLink(pid) }); } catch (e) { links.push({ id: pid, url: null }); } }
    out.push({ ...r, urls: JSON.parse(r.urls || "[]"), posts: links, left: Number(r.deadline) - t, overdue: ["open", "need_info"].includes(r.status) && t > Number(r.deadline) });
  }
  return out;
}
/** Hourly: remind the staff at 24 h and 8 h left. */
async function tick(t = now()) {
  await init();
  for (const c of await getQuery("SELECT * FROM takedown_cases WHERE status IN ('open','need_info')")) {
    const left = Number(c.deadline) - t;
    const step = left <= 8 * 3600e3 ? 2 : left <= 24 * 3600e3 ? 1 : 0;
    if (step > (c.reminded || 0)) {
      await runQuery("UPDATE takedown_cases SET reminded = ? WHERE id = ?", [step, c.id]);
      await alertStaff(c.id, `URGENT: TAKE IT DOWN #${c.id} - ${left <= 0 ? "OVERDUE" : Math.max(1, Math.round(left / 3600e3)) + " h left"}`, "Decide the case on /admin/takedowns.");
    }
  }
}

function register(app, { addUser }) {
  init().catch(() => {});
  const guard = require("./middleware/authGuard");
  const t = setInterval(() => tick().catch((e) => console.error("[takedown] tick:", e.message)), 60 * 60 * 1000);
  t.unref();
  app.get("/takedown", addUser, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.render("takedown", { user: req.user ? req.user.username : null, title: req.t ? req.t("td.title") : "Report intimate images shared without consent",
                             prefill: { url: String(req.query.url || "").slice(0, 500) } });
  });
  app.post("/api/takedown", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    try { res.json(await request(req.body || {}, { user: req.user, ip: guard.clientIp ? guard.clientIp(req) : req.ip })); }
    catch (e) { if (e.refuse) return res.status(e.status).json({ ok: false, error: e.message }); console.error("[takedown]", e); res.status(500).json({ ok: false, error: "Something went wrong - email abuse@publicaccess.tv." }); }
  });
  const staff = async (req) => {
    if (!req.user || !req.user.userId) return null;
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    return SP.can(u, "takedown.handle") ? u : null;
  };
  app.get("/admin/takedowns", addUser, async (req, res) => {
    const u = await staff(req);
    if (!u) return res.redirect("/login");
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex");
    res.render("admin/takedowns", { user: u.username, isAdmin: SP.can(u, "admin.sensitive_overview"), cases: await queue(), now: now() });
  });
  app.post("/api/admin/takedowns/:id/:act", addUser, async (req, res) => {
    const u = await staff(req);
    if (!u) return res.status(403).json({ ok: false, error: "Staff only." });
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    const note = (req.body || {}).note;
    try {
      const act = req.params.act;
      const r = act === "remove" ? await remove(u, req.params.id, note) : act === "reject" ? await reject(u, req.params.id, note) : act === "info" ? await needInfo(u, req.params.id, note) : null;
      if (!r) return res.status(404).json({ ok: false, error: "Unknown action." });
      res.json(r);
    } catch (e) { if (e.refuse) return res.status(e.status).json({ ok: false, error: e.message }); console.error("[takedown]", e); res.status(500).json({ ok: false, error: "failed" }); }
  });
}

module.exports = { init, register, request, fromReport, blockedFiles, remove, reject, needInfo, queue, tick, postsFromUrls, fileHash, SLA_MS, Refuse,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
