// veilgift.js - 1.99ajn padppl (owner point 23, "tip incognito / hidden users from the bridge and have it autoresolve" + his follow-up:
// "tipping veiled users can be used to reveal them / unmask them, so maybe we think about how best to do that"): 🎁 a GIFT to a frog
// name goes into the recipient's PRIVATE GIFT INBOX, never straight to a balance. DARK behind the `on` switch (/admin/users#gifts).
//
// THE MODEL (no unmasking):
//   - send: the person menu's "🎁 Send a gift" on a veiled row / line -> POST /api/rooms/:slug/gift {ref, amount, key}. Who is behind the
//     frog name is resolved on the server at send time (personref.js: the line's / entry's identity - so a gift to a frog whose session
//     has ended still lands), the PAT is ESCROWED from the sender (escrow/ledger.js holdInTx, service kind VGF - never a balance credit)
//   - the answer is ALWAYS {ok, label, amount, balance}, padded to MIN_MS, the same whether the frog name is an account, a Camfrog
//     login with no account yet, a blocked or capped recipient (then the gift is "withheld": never shown, refunded at due), or nobody
//   - the recipient: an inbox notice (kind "gift", private) and the Gifts card on /wallet - Accept (settleInTx to them; their own history
//     shows "Gift from @x"), Decline, Accept all; nothing is credited, announced or counted until they accept, at a time of their choosing
//   - every gift not accepted by due_at (30 days) goes back to the sender on the daily run (refundInTx: "gift returned") - the one bit the
//     sender can learn (accepted or not), on a fixed day that carries no timing (R2)
//   - the sender only ever sees the frog name: receipt, history ("🎁 Gift to a frog name", note "🐸 label"), export (label, amount, day).
//     Review fix: the gift's escrow hold is the SENDER's row, and its state / done_at would say whether and when it was accepted - so a
//     VGF hold is left out of the sender's data export (accountexport.js) and never blocks deleting their account (accountdelete.js; a
//     deleted sender's unaccepted gift goes to the House on its due day). Pepe's escrow view never lists service kinds (PEPE_SQL).
//   - NOTHING public: no Pepe line, no chat line, no tip jar / "you and X" / tip achievements / tip_people / social graph / tip volume /
//     streaks / achievement feed (none of them read the new ledger types: 'gift sent', 'gift accepted', 'gift returned'; checkWeb and
//     streaks are never called); the admins see the real parties (veil_gifts, admin only)
//   - limits: preset amounts only (AMOUNTS), no note, per sender HOUR_MAX / DAY_MAX / DAY_PAT; a silent per-recipient daily cap
// RESIDUALS (spec): R1 an accepted gift moves the recipient's public balance (mitigated: preset amounts, their own timing, Accept all,
// the warning on the card); R2 the day-30 refund bit; R3 the recipient may thank them; R4 the Camfrog room shows real names (incognito's
// existing property).
"use strict";
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");

const AMOUNTS = Object.freeze([100, 500, 1000, 5000, 10000]);
const HOUR_MAX = 5, DAY_MAX = 20, DAY_PAT = 50000, RECIPIENT_DAY_MAX = 20;
const DUE_MS = 30 * 86400e3, MIN_MS = 400, KEEP_MS = 365 * 86400e3;
const KIND = "VGF";
let clock = () => Date.now();
const now = () => clock();
let ON = false;
const isOn = () => ON;
class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code || null; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS veil_gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, hold_id TEXT, from_user TEXT NOT NULL, to_user TEXT,
        to_login TEXT, room_id TEXT, label TEXT, amount INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL,
        decided_at INTEGER, due_at INTEGER NOT NULL, settled_at INTEGER, key TEXT UNIQUE)`);
      await runQuery("CREATE INDEX IF NOT EXISTS veil_gifts_to ON veil_gifts (to_user, state)");
      await runQuery("CREATE INDEX IF NOT EXISTS veil_gifts_from ON veil_gifts (from_user, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS veil_gifts_due ON veil_gifts (state, due_at)");
      await runQuery("CREATE TABLE IF NOT EXISTS veilgift_config (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)");
      const r = (await getQuery("SELECT value FROM veilgift_config WHERE key = 'on'"))[0];
      ON = !!(r && r.value === "1");
      await require("./escrow/ledger").init();
      try { await require("./tips").noteReady(); } catch (e) { /* the note column */ }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const ESC = () => require("./escrow/ledger");
const tx = (fn) => require("./dbUtils").tx(fn);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");

async function balanceOf(userId) { const r = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [String(userId)]))[0]; return r ? Math.floor(Number(r.points_balance) || 0) : null; }

/** Send a gift to the person behind a frog name. -> the uniform answer (or throws for the SENDER's own problems only). */
async function send(me, R, ref, rawAmount, key = null) {
  const t0 = now();
  await init();
  if (!ON) throw new Refuse(404, "Gifts to frog names aren't on.");
  const amount = Math.floor(Number(rawAmount));
  if (!AMOUNTS.includes(amount)) throw new Refuse(400, "Pick one of the gift amounts.");
  const k = key ? "vg:" + String(me.userId) + ":" + String(key).slice(0, 64) : null;
  if (k) {
    const prev = (await getQuery("SELECT label, amount FROM veil_gifts WHERE key = ?", [k]))[0];
    if (prev) return pad(t0, { ok: true, label: prev.label, amount: prev.amount, balance: await balanceOf(me.userId), dup: true });
  }
  const p = await require("./personref").resolve(ref, { R });
  if (p.error) throw new Refuse(404, p.error);
  if (!p.veil) throw new Refuse(400, "Use 💸 Tip for someone shown by name.");
  const myLogin = me.camfrogUsername ? String(me.camfrogUsername).toLowerCase() : null;
  if ((p.userId && String(p.userId) === String(me.userId)) || (p.login && myLogin && p.login === myLogin)) throw new Refuse(400, "That's you.", "self");
  // the sender's own limits (they only ever learn about their OWN sends)
  const t = now();
  const mine = await getQuery("SELECT amount, created FROM veil_gifts WHERE from_user = ? AND created > ?", [String(me.userId), t - 86400e3]);
  if (mine.filter((x) => x.created > t - 3600e3).length >= HOUR_MAX || mine.length >= DAY_MAX) throw new Refuse(429, "That's a lot of gifts - try again later.", "rate");
  if (mine.reduce((s, x) => s + Number(x.amount), 0) + amount > DAY_PAT) throw new Refuse(429, `Up to ${fmt(DAY_PAT)} PAT in gifts a day.`, "rate");
  // withheld (never shown, refunded at due) - decided here, invisible in the answer
  let state = "pending";
  if (!p.userId && !p.login) state = "withheld";
  else if (p.userId) {
    try { if (await require("./blocks").towards(me.userId, p.userId)) state = "withheld"; } catch (e) { state = "withheld"; }
    // 1.99?? padppl rework (blocks.js): a sender who is under a frog name right now, and whom the recipient blocked under a frog name
    // (any frog name), is withheld too - the same answer, the same padded time (MIN_MS), so it tells the sender nothing
    if (state === "pending") {
      try {
        const PB = require("./padbans"), login = me.camfrogUsername ? String(me.camfrogUsername).toLowerCase() : await PB.loginOfCached(me.userId);
        if ((await PB.veiledNow(me.userId, login)) && (await require("./blocks").towards(me.userId, p.userId, { veiled: true, fromLogin: login }))) state = "withheld";
      } catch (e) { state = "withheld"; }
    }
    if (state === "pending") {
      const got = (await getQuery("SELECT COUNT(*) AS n FROM veil_gifts WHERE to_user = ? AND created > ?", [String(p.userId), t - 86400e3]))[0];
      if (Number(got && got.n) >= RECIPIENT_DAY_MAX) state = "withheld";
    }
  }
  const label = String(p.label || "someone").slice(0, 60);
  let row;
  try {
    row = await tx(async () => {
      const ins = await runQuery(`INSERT INTO veil_gifts (from_user, to_user, to_login, room_id, label, amount, state, created, due_at, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(me.userId), p.userId || null, p.userId ? null : (p.login || null), R ? String(R.id) : null, label, amount, state, t, t + DUE_MS, k]);
      const id = ins.id;
      const account = await ESC().accountFor({ userId: me.userId });
      const h = await ESC().holdInTx({ key: `vgf:${id}`, hid: null, account, amount, ref: `${KIND}-${id}`, reason: "gift sent", cp: null, via: "site" });
      await runQuery("UPDATE veil_gifts SET hold_id = ? WHERE id = ?", [h.hid, id]);
      if (h.txid) await runQuery("UPDATE transactions SET note = ? WHERE transactionId = ?", ["🐸 " + label, h.txid]).catch(() => {});
      return { id, hold: h.hid };
    });
  } catch (e) {
    if (e && e.code === "E_INSUFFICIENT_PAT") throw new Refuse(402, "You don't have that much PAT.", "funds");
    throw e;
  }
  // (review fix: the notice goes out AFTER the answer's fixed wait is measured - never awaited - so a real, unblocked recipient doesn't
  // answer slower than an unlinked login or a withheld gift)
  if (state === "pending" && p.userId) notify(p.userId, me, label, amount, R).catch(() => {});
  return pad(t0, { ok: true, label, amount, balance: await balanceOf(me.userId) });
}
async function pad(t0, out) { const d = MIN_MS - (now() - t0); if (d > 0 && clock === defaultClock) await sleep(d); return out; }
const defaultClock = clock;
async function notify(userId, me, label, amount, R) {
  let room = "a pad";
  try { const r = R ? require("./rooms").getCached(R.id) : null; room = (r && r.title) || (R && R.name) || room; } catch (e) { /* the name only */ }
  try {
    await require("./inbox").addSafe(String(userId), { kind: "gift", title: `🎁 @${me.username} sent you a gift of ${fmt(amount)} PAT while you were 🐸 ${label} in ${room}`,
      body: "Nothing changes until you accept it - open your gifts to accept or decline.", link: "/wallet#gifts" });
  } catch (e) { /* the gift is in the inbox anyway */ }
}

/** The recipient's gifts (pending first). Never the sender's view: a sender sees only their own frog-name receipts (sentBy). */
async function inboxOf(userId) {
  await init();
  const rows = await getQuery(`SELECT g.id, g.amount, g.label, g.room_id, g.created, g.due_at, g.state, u.username AS from_name FROM veil_gifts g
                               LEFT JOIN users u ON u.userId = g.from_user WHERE g.to_user = ? AND g.state IN ('pending', 'accepted', 'declined')
                               ORDER BY (g.state = 'pending') DESC, g.created DESC LIMIT 200`, [String(userId)]);
  return rows.map((r) => ({ id: Number(r.id), amount: Number(r.amount), label: r.label, from: r.from_name || null, at: Number(r.created), due: Number(r.due_at), state: r.state }));
}
/** What the sender may know: the frog name, the amount, the day - never accepted / declined. */
async function sentBy(userId) {
  await init();
  return (await getQuery("SELECT label, amount, created FROM veil_gifts WHERE from_user = ? ORDER BY created DESC LIMIT 200", [String(userId)]))
    .map((r) => ({ label: r.label, amount: Number(r.amount), at: Number(r.created) }));
}
async function accept(me, id) {
  await init();
  const g = (await getQuery("SELECT * FROM veil_gifts WHERE id = ? AND to_user = ?", [Math.floor(Number(id)), String(me.userId)]))[0];
  if (!g || g.state !== "pending") throw new Refuse(404, "That gift isn't waiting for you.");
  await tx(async () => {
    await ESC().settleInTx({ key: `vga:${g.id}`, hids: [g.hold_id], ref: `${KIND}-${g.id}`, fees: [],
      payouts: [{ userId: String(me.userId), amount: Number(g.amount), reason: "gift accepted", cp: String(g.from_user) }] });
    const u = await runQuery("UPDATE veil_gifts SET state = 'accepted', decided_at = ?, settled_at = ? WHERE id = ? AND state = 'pending'", [now(), now(), g.id]);
    if (!u || u.changes !== 1) throw new Refuse(409, "That gift changed meanwhile.");
  });
  return { ok: true, amount: Number(g.amount), balance: await balanceOf(me.userId) };
}
async function acceptAll(me) {
  const list = (await inboxOf(me.userId)).filter((g) => g.state === "pending");
  let n = 0, total = 0;
  for (const g of list) { try { const r = await accept(me, g.id); n++; total += r.amount; } catch (e) { /* one changed meanwhile */ } }
  return { ok: true, n, total, balance: await balanceOf(me.userId) };
}
async function decline(me, id) {
  await init();
  const u = await runQuery("UPDATE veil_gifts SET state = 'declined', decided_at = ? WHERE id = ? AND to_user = ? AND state = 'pending'", [now(), Math.floor(Number(id)), String(me.userId)]);
  if (!u || u.changes !== 1) throw new Refuse(404, "That gift isn't waiting for you.");
  return { ok: true };
}
/** The daily run: every gift not accepted by its due day goes back to its sender (to the House when the sender's account is gone). */
async function settleDue() {
  await init();
  const due = await getQuery("SELECT * FROM veil_gifts WHERE state IN ('pending', 'declined', 'withheld') AND due_at <= ? LIMIT 500", [now()]);
  let n = 0;
  for (const g of due) {
    try {
      await tx(async () => {
        try { await ESC().refundInTx({ key: `vgr:${g.id}`, hid: g.hold_id, reason: "gift returned" }); }
        catch (e) {
          if (!(e && e.code === "E_TARGET_NOT_FOUND")) throw e;
          await ESC().settleInTx({ key: `vgr:${g.id}`, hids: [g.hold_id], ref: `${KIND}-${g.id}`, payouts: [], fees: [["jackpot", Number(g.amount)]] });
        }
        await runQuery("UPDATE veil_gifts SET state = 'refunded', settled_at = ? WHERE id = ?", [now(), g.id]);
      });
      n++;
    } catch (e) { console.error("[veilgift] refund " + g.id + ":", e.message); }
  }
  try { await runQuery("DELETE FROM veil_gifts WHERE settled_at IS NOT NULL AND settled_at < ?", [now() - KEEP_MS]); } catch (e) { /* later */ }
  return n;
}
/** A Camfrog login just linked an account: its pending gifts are theirs now (within their 30 days). */
async function linked(userId, login) {
  try {
    await init();
    const l = String(login || "").toLowerCase();
    const rows = await getQuery("SELECT id FROM veil_gifts WHERE to_login = ? AND to_user IS NULL AND state = 'pending' AND due_at > ?", [l, now()]);
    if (!rows.length) return;
    await runQuery("UPDATE veil_gifts SET to_user = ?, to_login = NULL WHERE to_login = ? AND to_user IS NULL AND state = 'pending'", [String(userId), l]);
    await require("./inbox").addSafe(String(userId), { kind: "gift", title: `🎁 ${rows.length === 1 ? "A gift is" : rows.length + " gifts are"} waiting for you`, body: "Sent to you while you were under a frog name.", link: "/wallet#gifts" });
  } catch (e) { console.error("[veilgift] link:", e.message); }
}
async function setOn(me, on) {
  if (!SP.can(me, "pads.config")) throw new Refuse(403, "Admins only.");
  await init();
  await runQuery("INSERT INTO veilgift_config (key, value, updated, actor) VALUES ('on', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor",
    [on ? "1" : "0", now(), me.username]);
  ON = !!on;
  await require("./adminaudit").record({ userId: me.userId, username: me.username }, "veil_gifts", null, { op: on ? "on" : "off" }, null);
  return { on: ON };
}

function register(app, { addUser, bySlug = null }) {
  init().catch((e) => console.error("[veilgift] init:", e.message));
  const t = setInterval(() => { settleDue().catch(() => {}); }, 6 * 3600e3); if (t.unref) t.unref();
  const t0 = setTimeout(() => { settleDue().catch(() => {}); }, 120 * 1000); if (t0.unref) t0.unref();   // (review fix: soon after a start too)
  const guard = require("./middleware/authGuard");
  const meOf = async (req) => (req.user && req.user.userId ? (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0] : null);
  const writeOk = (req) => req.is("application/json") && req.get("X-Requested-With") === "fetch" && guard.sameSite(req);
  const fail = (res, e) => {
    if (!(e && e.status)) console.error("[veilgift]", e);           // (review fix: a 500 leaves a log line)
    res.status(e && e.status ? e.status : 500).json({ ok: false, error: e && e.status ? e.message : "Something went wrong - nothing was sent." });
  };
  app.post("/api/rooms/:slug/gift", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!writeOk(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    try {
      const me = await meOf(req); if (!me) return res.status(401).json({ ok: false, error: "Sign in first." });
      const R = (bySlug || ((s) => require("./bridge").bySlug(s)))(String(req.params.slug).slice(0, 128));
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      const b = req.body || {};
      // (review fix: a frog name's row / line only in a pad this sender may see - the same answer as a line that's gone)
      if (!(await require("./personref").padOk(b.ref, me, R))) return res.status(404).json({ ok: false, error: "That line isn't here any more." });
      res.json(await send(me, R, b.ref, b.amount, b.key));
    } catch (e) { fail(res, e); }
  });
  app.get("/api/gifts", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try { const me = await meOf(req); if (!me) return res.status(401).json({ ok: false, error: "Sign in first." }); await init();
      res.json({ ok: true, on: ON, gifts: await inboxOf(me.userId), amounts: AMOUNTS }); } catch (e) { fail(res, e); }
  });
  app.post("/api/gifts/:id/:op(accept|decline)", addUser, express.json({ limit: "1kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!writeOk(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    try { const me = await meOf(req); if (!me) return res.status(401).json({ ok: false, error: "Sign in first." });
      res.json(req.params.op === "accept" ? await accept(me, req.params.id) : await decline(me, req.params.id)); } catch (e) { fail(res, e); }
  });
  app.post("/api/gifts/accept-all", addUser, express.json({ limit: "1kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!writeOk(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    try { const me = await meOf(req); if (!me) return res.status(401).json({ ok: false, error: "Sign in first." }); res.json(await acceptAll(me)); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/gifts", addUser, express.json({ limit: "1kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!writeOk(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    try { res.json({ ok: true, ...(await setOn(await meOf(req), (req.body || {}).on === true)) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, send, accept, acceptAll, decline, inboxOf, sentBy, settleDue, linked, setOn, isOn, AMOUNTS, HOUR_MAX, DAY_MAX, DAY_PAT, DUE_MS, KIND,
  Refuse, _setClock: (f) => { clock = f; }, _setOn: (v) => { ON = !!v; } };
