// polls.js — Pepe's room polls on PATV (/polls).
//
// Polls run in Pepe (one at a time across the rooms); he pushes the current poll and up to 50 past
// ones here whenever something changes. Voting, starting and ending a poll from the site go through
// the action queue (actions.js): kind=poll.vote / poll.create / poll.end. Linked users act as their
// Camfrog name; unlinked accounts can still vote, as "🌐username".
//
// 1.99ns (audit 5.7, Phase 1): polls can live on the SITE instead. A Pepe switched to it (`!poll backend on`, his
// polls_client.json) attaches: his running poll (if any) is handed over and from then on the site owns the poll and its
// votes - chat !poll / !vote / numbers are calls here (/api/polls/bot/act), web votes / starts / ends are done here at
// once (no action queue, with or without Pepe), and Pepe hears the web's changes on /api/polls/bot/poll (events) to
// announce them in the room. `!poll backend off` detaches: the running poll goes back to Pepe and local polls run as
// before. Site switch polls_meta.enabled: default ON on staging, OFF on prod (an admin turns it on).
const { runQuery, getQuery } = require("./dbUtils");
const actions = require("./actions");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT, created TEXT, updated INTEGER)`).catch(() => {});
const KEEP_DAYS = 90;
const MAX_OPTIONS = 8;
const WEB = "🌐";

const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

// ── 1.99ns: site-owned polls (the backend switch) ──
const crypto = require("crypto");
const bready = ready.then(() => runQuery("CREATE TABLE IF NOT EXISTS polls_meta (key TEXT PRIMARY KEY, value TEXT)"))
  .then(() => runQuery(`CREATE TABLE IF NOT EXISTS poll_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
                        poll_id TEXT, origin TEXT, data TEXT)`)).catch((e) => console.error("[polls] backend tables:", e.message));
async function pmeta(k) {
  await bready;
  const r = (await getQuery("SELECT value FROM polls_meta WHERE key = ?", [k]))[0];
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
const setPmeta = (k, v) => runQuery("INSERT INTO polls_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(v)]);
async function backendEnabled() {
  const v = await pmeta("enabled");
  if (v === true || v === false) return v;
  return !!process.env.STAGING;
}
/** The site owns the polls right now (a Pepe attached and hasn't detached). */
async function backendLive() { return !!(await pmeta("live")) && (await backendEnabled()); }
let chain = Promise.resolve();
const serial = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };
const waiters = new Set();
async function event(kind, pollId, origin, data) {
  await runQuery("INSERT INTO poll_events (ts, kind, poll_id, origin, data) VALUES (?, ?, ?, ?, ?)", [Date.now(), kind, pollId || null, origin || null, JSON.stringify(data || {})]);
  if (Math.random() < 0.05) runQuery("DELETE FROM poll_events WHERE ts < ?", [Date.now() - 48 * 3600000]).catch(() => {});
  for (const w of [...waiters]) w();
}
async function savePoll(p) {
  await runQuery(`INSERT INTO polls (id, data, status, created, updated) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status, created = excluded.created, updated = excluded.updated`,
                 [p.id, JSON.stringify(p), p.status, p.created_at, Date.now()]);
  require("./achsocial").pokePoll(p);                        // 1.99oz: 🗳️ poll achievements (voters, a poll's creator)
}
async function activePoll() {
  const r = (await getQuery("SELECT data FROM polls WHERE status = 'active' ORDER BY updated DESC LIMIT 1"))[0];
  return r ? JSON.parse(r.data) : null;
}
const nowStr = () => new Date().toISOString().slice(0, 19).replace("T", " ");
/**
 * One poll verb, serialized (one change at a time). -> {ok, poll?, msg?, code?}
 *   create {question, options, creator}   vote {voter, alias?, option (1-based), poll_id?}   end {by, admin}   current
 */
function act(verb, b, origin) {
  return serial(async () => {
    await bready;
    if (!(await backendLive())) return { ok: false, code: "off", msg: "polls aren't on the site right now" };
    const cur = await activePoll();
    if (verb === "current" || verb === "results") return { ok: true, poll: cur ? view(cur, []) : null };
    if (verb === "create") {
      if (cur) return { ok: false, code: "busy", msg: "a poll is already running — vote on it, or wait for it to end", poll: view(cur, []) };
      const q = str(b.question, 300).trim();
      const options = (Array.isArray(b.options) ? b.options : []).map((o) => str(o, 120).trim()).filter(Boolean).slice(0, MAX_OPTIONS);
      if (!q || options.length < 2) return { ok: false, code: "bad", msg: "a poll needs a question and at least two options" };
      const p = cleanPoll({ id: "poll_" + crypto.randomBytes(4).toString("hex"), question: q.endsWith("?") ? q : q + "?", options, votes: {},
                            creator: str(b.creator, 60), status: "active", created_at: nowStr() });
      await savePoll(p);
      await event("created", p.id, origin, { poll: p });
      return { ok: true, poll: view(p, []) };
    }
    if (!cur) return { ok: false, code: "none", msg: "no active poll" };
    if (verb === "vote") {
      if (b.poll_id && b.poll_id !== cur.id) return { ok: false, code: "ended", msg: "that poll has ended" };
      const n = Math.floor(Number(b.option));
      if (!(n >= 1 && n <= cur.options.length)) return { ok: false, code: "bad", msg: `pick 1-${cur.options.length}` };
      const voter = str(b.voter, 60).trim();
      if (!voter) return { ok: false, code: "bad", msg: "who is voting?" };
      const alias = str(b.alias, 60).trim();
      for (const k of Object.keys(cur.votes)) cur.votes[k] = (cur.votes[k] || []).filter((x) => !same(x, voter) && !(alias && same(x, alias)));
      cur.votes[n - 1] = (cur.votes[n - 1] || []).concat([voter]);
      await savePoll(cur);
      await event("voted", cur.id, origin, { voter, option: n, text: cur.options[n - 1] });
      return { ok: true, poll: view(cur, []), msg: `voted: ${cur.options[n - 1]}` };
    }
    if (verb === "end") {
      if (!(b.admin || same(b.by, cur.creator))) return { ok: false, code: "denied", msg: "only the poll's creator or an admin can end it" };
      cur.status = "ended";
      await savePoll(cur);
      const v = view(cur, []);
      await event("ended", cur.id, origin, { poll: cur, total: v.total, by: str(b.by, 60) });
      return { ok: true, poll: v };
    }
    return { ok: false, code: "bad", msg: "unknown verb" };
  });
}
/** Pepe attaches (backend on): his running poll, if any, becomes the site's. */
function attach(current) {
  return serial(async () => {
    await bready;
    if (!(await backendEnabled())) return { ok: false, code: "off", msg: "the polls backend is switched off on this site" };
    if (current && typeof current === "object" && current.status === "active") {
      const p = cleanPoll(current);
      if (p) {
        for (const r of await getQuery("SELECT id, data FROM polls WHERE status = 'active' AND id != ?", [p.id])) {
          const d = JSON.parse(r.data); d.status = "ended";
          await runQuery("UPDATE polls SET status = 'ended', data = ?, updated = ? WHERE id = ?", [JSON.stringify(d), Date.now(), r.id]);
        }
        await savePoll(p);
      }
    }
    await setPmeta("live", true);
    const last = (await getQuery("SELECT MAX(id) AS m FROM poll_events"))[0];
    return { ok: true, poll: await activePoll(), cursor: Number(last && last.m) || 0 };
  });
}
/** Detach (backend off): the running poll goes back to Pepe; the site stops taking votes. */
function detach() {
  return serial(async () => {
    await bready;
    await setPmeta("live", false);
    return { ok: true, poll: await activePoll(), polls: (await getQuery("SELECT data FROM polls ORDER BY created DESC LIMIT 60")).map((r) => JSON.parse(r.data)) };
  });
}
async function eventsAfter(after, waitS) {
  await bready;
  const read = () => getQuery("SELECT id, ts, kind, poll_id, origin, data FROM poll_events WHERE id > ? ORDER BY id LIMIT 100", [Math.max(0, Math.floor(Number(after) || 0))]);
  let rows = await read();
  if (!rows.length && waitS > 0) {
    await new Promise((res) => {
      let t = null;
      const w = () => { waiters.delete(w); clearTimeout(t); res(); };
      t = setTimeout(w, Math.min(8, waitS) * 1000);
      waiters.add(w);
    });
    rows = await read();
  }
  return rows.map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, poll_id: r.poll_id, origin: r.origin, data: JSON.parse(r.data || "{}") }));
}
/** The website's /act poll forms while the site owns the polls. -> the message to show, or null (not live: queue to Pepe). */
async function fromForm(userId, kind, words) {
  if (!(await backendLive())) return null;
  const me = (await getQuery("SELECT username, camfrogUsername, class FROM users WHERE userId = ?", [userId]))[0];
  if (!me) return "Couldn't find your account.";
  if (kind === "poll.vote") {
    const r = await act("vote", { poll_id: words[0], option: words[1], voter: me.camfrogUsername || WEB + me.username,
                                  alias: me.camfrogUsername ? WEB + me.username : "" }, "web");
    return r.ok ? "🗳️ " + r.msg : r.msg;
  }
  if (kind === "poll.create") {
    if (!me.camfrogUsername) return "Link your Camfrog name first (type !verify in a Camfrog room) - polls are started as it.";
    const r = await act("create", { question: words[0], options: words.slice(1), creator: me.camfrogUsername }, "web");
    return r.ok ? "🗳️ Poll started." : r.msg;
  }
  if (kind === "poll.end") {
    const r = await act("end", { by: me.camfrogUsername || WEB + me.username, admin: me.class === "Admin" }, "web");
    return r.ok ? "🗳️ Poll ended." : r.msg;
  }
  return null;
}


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
  require("./userlinks").install(app);
  // 1.99ns: the polls backend (Pepe's !poll backend on|off)
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) { console.error("[polls] bot:", e); res.status(500).json({ ok: false, error: "server_error" }); }
  };
  app.post("/api/polls/bot/act", bot(async (b) => {
    const verb = String(b.verb || "");
    if (verb === "attach") return attach(b.current);
    if (verb === "detach") return detach();
    if (verb === "status") return { ok: true, enabled: await backendEnabled(), live: await backendLive() };
    return act(verb, b, "camfrog");
  }));
  app.post("/api/polls/bot/poll", bot(async (b) => ({ ok: true, live: await backendLive(), events: await eventsAfter(b.after, Number(b.wait) || 0) })));
  app.post("/api/polls/admin/export", bot(async () => ({ ok: true, live: await backendLive(),
    polls: (await getQuery("SELECT data FROM polls ORDER BY created DESC")).map((r) => JSON.parse(r.data)) })));
  app.post("/api/admin/polls-backend", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!row || row.class !== "Admin") return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    await setPmeta("enabled", !!(req.body || {}).on);
    res.json({ ok: true, enabled: await backendEnabled() });
  });   // 1.99dt: <%- ul(name) %> in its views links names to profiles
  app.post("/api/polls/sync", async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    const list = Array.isArray(body.polls) ? body.polls.slice(0, 60) : [];
    try {
      await ready;
      // 1.99ns: while the site owns the polls a local Pepe's snapshot would overwrite them - refused (he detaches first)
      if (await backendLive()) return res.status(409).json({ success: false, error: "the site owns the polls (backend live)" });
      let stored = 0;
      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const p = cleanPoll(raw);
        if (!p) continue;
        await runQuery(`INSERT INTO polls (id, data, status, created, updated) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status,
                        created = excluded.created, updated = excluded.updated`,
          [p.id, JSON.stringify(p), p.status, p.created_at, Date.now()]);
        require("./achsocial").pokePoll(p);                  // 1.99oz: 🗳️ poll achievements (a local Pepe's snapshot)
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

module.exports = { register, view, cleanPoll, act, attach, detach, eventsAfter, fromForm, backendLive, backendEnabled };
