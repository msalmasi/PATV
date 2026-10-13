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
  id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT, created TEXT, updated INTEGER)`).catch(() => {})
  // 1.99ur: the pad a poll belongs to (padlinks.js): set from its pad / room when first stored, moved by a pad re-key
  .then(() => runQuery("ALTER TABLE polls ADD COLUMN pad TEXT").catch(() => {}));
const padlinks = require("./padlinks");
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
/** One polls row; the pad column is filled the first time the poll's pad / room resolves and never overwritten (padlinks.js). */
async function storePoll(p) {
  await ready;
  let pad = null;
  try { pad = padlinks.resolve(p); } catch (e) { pad = null; }
  await runQuery(`INSERT INTO polls (id, data, status, created, updated, pad) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status, created = excluded.created,
                  updated = excluded.updated, pad = COALESCE(polls.pad, excluded.pad)`,
                 [p.id, JSON.stringify(p), p.status, p.created_at, Date.now(), pad]);
}
async function savePoll(p) {
  await storePoll(p);
  require("./achsocial").pokePoll(p);                        // 1.99pa: 🗳️ poll achievements (voters, a poll's creator)
}
/** The running poll stored for exactly this pad (null = the site-wide ones). */
async function activeExact(pad) {
  const r = pad ? (await getQuery("SELECT data FROM polls WHERE status = 'active' AND pad = ? ORDER BY updated DESC LIMIT 1", [pad]))[0]
    : (await getQuery("SELECT data FROM polls WHERE status = 'active' AND pad IS NULL ORDER BY updated DESC LIMIT 1"))[0];
  return r ? JSON.parse(r.data) : null;
}
/**
 * The running poll. 1.99ur: polls belong to pads - one running poll PER PAD. `pad` undefined = the newest running poll anywhere
 * (callers that don't say where); a pad id = that pad's running poll, else a running site-wide one (pad NULL: polls from before
 * pads, or made without one); null = the site-wide one.
 */
async function activePoll(pad) {
  if (pad === undefined) {
    const r = (await getQuery("SELECT data FROM polls WHERE status = 'active' ORDER BY updated DESC LIMIT 1"))[0];
    return r ? JSON.parse(r.data) : null;
  }
  return (pad ? await activeExact(pad) : null) || activeExact(null);
}
async function pollById(id) {
  const r = (await getQuery("SELECT data FROM polls WHERE id = ?", [String(id || "")]))[0];
  return r ? JSON.parse(r.data) : null;
}
/** The pad a bot / web call means: an explicit pad (id / slug), else the chat room's pad (null = site-wide); undefined when neither was sent. */
async function padOfCall(b) {
  if (!b || (b.pad === undefined && b.room === undefined)) return undefined;
  await padlinks.ready();
  return padlinks.resolve({ pad: b.pad, room: b.room }) || null;
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
    if (verb === "active") {
      // 1.99vb: every running poll (one per pad) - Pepe's map of which rooms have a poll
      const rows = await getQuery("SELECT data, pad FROM polls WHERE status = 'active' ORDER BY updated DESC LIMIT 100");
      return { ok: true, polls: rows.map((r) => Object.assign(view(JSON.parse(r.data), []), r.pad ? { pad: r.pad } : {})) };
    }
    const pad = await padOfCall(b);
    // 1.99ur: a vote / end from the website names its poll (the form's a0); chat means the room's pad's running poll
    let cur;
    if (b.poll_id && (verb === "vote" || verb === "end")) {
      cur = await pollById(b.poll_id);
      if (cur && cur.status !== "active") return { ok: false, code: "ended", msg: "that poll has ended" };
    } else cur = await activePoll(pad);
    if (verb === "current" || verb === "results") return { ok: true, poll: cur ? view(cur, []) : null };
    if (verb === "create") {
      // one running poll per pad: only a running poll of the SAME pad (or, without a pad, any) blocks a new one
      const mine = pad === undefined ? cur : await activeExact(pad);
      if (mine) return { ok: false, code: "busy", msg: "a poll is already running here — vote on it, or wait for it to end", poll: view(mine, []) };
      const q = str(b.question, 300).trim();
      const options = (Array.isArray(b.options) ? b.options : []).map((o) => str(o, 120).trim()).filter(Boolean).slice(0, MAX_OPTIONS);
      if (!q || options.length < 2) return { ok: false, code: "bad", msg: "a poll needs a question and at least two options" };
      const p = cleanPoll({ id: "poll_" + crypto.randomBytes(4).toString("hex"), question: q.endsWith("?") ? q : q + "?", options, votes: {},
                            creator: str(b.creator, 60), status: "active", created_at: nowStr(),
                            ...(pad ? { pad } : {}), ...(b.room ? { room: str(b.room, 128) } : {}) });
      await savePoll(p);
      await event("created", p.id, origin, { poll: p });
      return { ok: true, poll: view(p, []) };
    }
    if (!cur) return { ok: false, code: "none", msg: "no active poll" };
    if (verb === "vote") {
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
async function fromForm(userId, kind, words, opts = {}) {
  if (!(await backendLive())) return null;
  const me = (await getQuery("SELECT username, camfrogUsername, class FROM users WHERE userId = ?", [userId]))[0];
  if (!me) return "Couldn't find your account.";
  if (kind === "poll.vote") {
    const r = await act("vote", { poll_id: words[0], option: words[1], voter: me.camfrogUsername || WEB + me.username,
                                  alias: me.camfrogUsername ? WEB + me.username : "" }, "web");
    return r.ok ? "🗳️ " + r.msg : r.msg;
  }
  if (kind === "poll.create") {
    // 1.99ur: the pad picker (actions.js checked the user may use it; "" = site-wide)
    // 1.99wr (connections audit A): the PATV account is the author - its chat login when linked, else "🌐username" (the
    // name its votes already go under; it may end its own poll by that name, canEndOf)
    const r = await act("create", { question: words[0], options: words.slice(1), creator: me.camfrogUsername || WEB + me.username,
                                    pad: opts.pad == null ? "" : opts.pad }, "web");
    return r.ok ? "🗳️ Poll started." : r.msg;
  }
  if (kind === "poll.end") {
    const r = await act("end", { poll_id: words[0] || undefined, by: me.camfrogUsername || WEB + me.username, admin: me.class === "Admin" }, "web");
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
    // 1.99ur: the pad it belongs to (padlinks.js) / the chat room it was started in
    ...(p.pad ? { pad: str(p.pad, 128) } : {}), ...(p.room ? { room: str(p.room, 128) } : {}),
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
        await storePoll(p);
        require("./achsocial").pokePoll(p);                  // 1.99pa: 🗳️ poll achievements (a local Pepe's snapshot)
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

  // 1.99ur: /polls lists every pad's running poll (one per pad) and the past ones; ?pad=<slug|none> filters by pad;
  // /polls/<id> is a poll's own page (the permalink Pepe's announcements and the feed cards link to)
  const page = async (req, res, focusId) => {
    try {
      await ready;
      await padlinks.ready();
      const PA = require("./padaccess");
      try { await PA.init(); } catch (e) { /* the gate's own problem */ }
      let me = null, acts = [], keys = [];
      if (req.user && req.user.userId) {
        me = (await getQuery("SELECT username, camfrogUsername, class, points_balance FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
        acts = await actions.recentFor(req.user.userId, "polls");
        if (me) keys = [me.camfrogUsername, WEB + me.username].filter(Boolean);
      }
      const want = padlinks.fromParam(req.query.pad);
      const rows = await getQuery("SELECT data, pad FROM polls ORDER BY created DESC, updated DESC LIMIT 400");
      let all = rows.map((r) => {
        const d = JSON.parse(r.data);
        const v = view(d, keys);
        v.padId = r.pad || padlinks.resolve(d) || null;
        v.padv = padlinks.view(v.padId);
        return v;
      }).filter((p) => !p.padId || PA.canSee(req.user || null, p.padId));
      let focus = null;
      if (focusId) {
        focus = all.find((p) => p.id === focusId) || null;
        if (!focus) {
          return res.status(404).render("notFound", { user: req.user ? req.user.username : null, heading: "No such poll",
            message: "That poll doesn't exist (or it's on a pad you can't see).", title: "Poll not found" });
        }
      }
      const counts = new Map();
      for (const p of all) { const k = p.padv ? p.padv.slug : "none"; counts.set(k, { slug: k, title: p.padv ? p.padv.title : null, n: ((counts.get(k) || {}).n || 0) + 1 }); }
      if (want !== null) all = all.filter((p) => (p.padId || "") === want);
      const isAdmin = !!(me && me.class === "Admin");
      const canEndOf = (p) => !!(p && p.status === "active" && me && (isAdmin || (me.camfrogUsername && same(me.camfrogUsername, p.creator))
                                                                     || same(WEB + me.username, p.creator)));
      const actives = all.filter((p) => p.status === "active");
      for (const p of actives) p.canEnd = canEndOf(p);
      if (focus) focus.canEnd = canEndOf(focus);
      const past = all.filter((p) => p.status !== "active").slice(0, 50);
      const pv = want ? padlinks.view(want) : null;
      if (pv && !counts.has(pv.slug)) counts.set(pv.slug, { slug: pv.slug, title: pv.title, n: 0 });
      const filter = { pad: want, slug: want === "" ? "none" : pv ? pv.slug : "", padTitle: pv ? pv.title : null, padUrl: pv ? pv.url : null,
                       pads: [...counts.values()].sort((a, b) => (a.slug === "none") - (b.slug === "none") || String(a.title).localeCompare(String(b.title))) };
      res.render("polls", {
        user: req.user ? req.user.username : null, me, actives, active: actives[0] || null, past, focus, filter, maxOptions: MAX_OPTIONS,
        canCreate: !!(me && (me.camfrogUsername || await backendLive())),       // 1.99wr: the site runs polls by account
        canEnd: canEndOf(actives[0]), pick: await padlinks.choicesFor(req.user, req.query.pad || (focus && focus.padv ? focus.padv.slug : "")),
        acts, msg: req.query.msg ? String(req.query.msg).trim().slice(0, 200) : null,
      });
    } catch (e) {
      console.error("[polls] page:", e);
      res.status(500).send("Something went wrong.");
    }
  };
  app.get("/polls", addUser, (req, res) => page(req, res, null));
  app.get("/polls/:id", addUser, (req, res) => {
    const id = String(req.params.id || "");
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return res.redirect("/polls");
    return page(req, res, id);
  });
}

module.exports = { register, view, cleanPoll, act, attach, detach, eventsAfter, fromForm, backendLive, backendEnabled };
