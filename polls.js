// polls.js — Pepe's room polls on PATV (/polls).
//
// Polls run in Pepe (one at a time across the rooms); he pushes the current poll and up to 50 past
// ones here whenever something changes. Voting, starting and ending a poll from the site go through
// the action queue (actions.js): kind=poll.vote / poll.create / poll.end. Linked users act as their
// Camfrog name; unlinked accounts can still vote, as "🌐username".
const { runQuery, getQuery } = require("./dbUtils");
const actions = require("./actions");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT, created TEXT, updated INTEGER)`).catch(() => {});
const KEEP_DAYS = 90;
const MAX_OPTIONS = 8;
const WEB = "🌐";

const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

function cleanPoll(p) {
  const id = str(p.id, 40);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const options = (Array.isArray(p.options) ? p.options : []).slice(0, MAX_OPTIONS).map((o) => str(o, 120));
  const votes = {};
  const src = p.votes && typeof p.votes === "object" ? p.votes : {};
  options.forEach((_, i) => {
    const list = Array.isArray(src[i]) ? src[i] : Array.isArray(src[String(i)]) ? src[String(i)] : [];
    votes[i] = list.slice(0, 2000).map((n) => str(n, 60));
  });
  const created = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(p.created_at || "")) ? String(p.created_at) : "";
  return {
    id, question: str(p.question, 300), options, votes, creator: str(p.creator, 60),
    status: p.status === "active" ? "active" : "ended", created_at: created,
  };
}

/** Add tallies, percentages, the leader(s) and which option this user voted for. */
function view(p, keys) {
  const counts = p.options.map((_, i) => (p.votes[i] || []).length);
  const total = counts.reduce((a, c) => a + c, 0);
  const top = Math.max(0, ...counts);
  const mine = p.options.findIndex((_, i) => (p.votes[i] || []).some((n) => keys.some((k) => same(k, n))));
  return {
    ...p, total, mineIdx: mine,
    rows: p.options.map((text, i) => ({
      text, count: counts[i], pct: total ? Math.round((counts[i] / total) * 100) : 0,
      lead: total > 0 && counts[i] === top, mine: i === mine,
    })),
  };
}

function register(app, { isBotToken, addUser }) {
  app.post("/api/polls/sync", async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    const list = Array.isArray(body.polls) ? body.polls.slice(0, 60) : [];
    try {
      await ready;
      let stored = 0;
      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const p = cleanPoll(raw);
        if (!p) continue;
        await runQuery(`INSERT INTO polls (id, data, status, created, updated) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status,
                        created = excluded.created, updated = excluded.updated`,
          [p.id, JSON.stringify(p), p.status, p.created_at, Date.now()]);
        stored++;
      }
      // Pepe runs one poll at a time: anything still "active" that he didn't just send as active has ended
      const activeIds = list.filter((p) => p && p.status === "active").map((p) => str(p.id, 40));
      if (list.length) {
        const stale = await getQuery("SELECT id, data FROM polls WHERE status = 'active'");
        for (const r of stale) {
          if (activeIds.includes(r.id)) continue;
          const d = JSON.parse(r.data);
          d.status = "ended";
          await runQuery("UPDATE polls SET status = 'ended', data = ?, updated = ? WHERE id = ?", [JSON.stringify(d), Date.now(), r.id]);
        }
      }
      const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 19).replace("T", " ");
      await runQuery("DELETE FROM polls WHERE status = 'ended' AND created != '' AND created < ?", [cutoff]);
      res.json({ success: true, stored });
    } catch (e) {
      console.error("[polls] sync:", e);
      res.status(500).json({ success: false });
    }
  });

  app.get("/polls", addUser, async (req, res) => {
    try {
      await ready;
      let me = null, acts = [], keys = [];
      if (req.user && req.user.userId) {
        me = (await getQuery("SELECT username, camfrogUsername, class, points_balance FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
        acts = await actions.recentFor(req.user.userId, "polls");
        if (me) keys = [me.camfrogUsername, WEB + me.username].filter(Boolean);
      }
      const rows = await getQuery("SELECT data FROM polls ORDER BY created DESC, updated DESC LIMIT 80");
      const all = rows.map((r) => view(JSON.parse(r.data), keys));
      const active = all.find((p) => p.status === "active") || null;
      const past = all.filter((p) => p !== active && p.status !== "active").slice(0, 50);
      const isAdmin = !!(me && me.class === "Admin");
      const canEnd = !!(active && me && (isAdmin || (me.camfrogUsername && same(me.camfrogUsername, active.creator))
                                         || same(WEB + me.username, active.creator)));
      res.render("polls", {
        user: req.user ? req.user.username : null, me, active, past, canEnd, maxOptions: MAX_OPTIONS,
        acts, msg: req.query.msg ? String(req.query.msg).trim().slice(0, 200) : null,
      });
    } catch (e) {
      console.error("[polls] page:", e);
      res.status(500).send("Something went wrong.");
    }
  });
}

module.exports = { register, view, cleanPoll };
