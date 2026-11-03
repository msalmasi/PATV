// padpepe.js — the pad page's 🐸 Pepe submenu (1.99qr): Pepe's paid people-commands from the live user list's ⋯ menu and
// from a viewer's cam preview - 👀 !look, 🔥 !camroast and 🎤 !roast on someone in the room.
//
// Same path, permissions and limits as typing the command in the pad's relay box (bridge-relay.js runCmd):
//   * signed in + a linked Camfrog name (the command runs AS that login in the room - Pepe's own rules, prices, room
//     switches, admin-free, his rate limits, the "🌐 name (web): !look bob" echo, his mod log);
//   * the room live and web commands on there (R.cmds non-empty) and the command on its menu;
//   * the site's per-account command limit (relay.limited "cmd|<user>": one per 2 s, 10 a minute - the same bucket as the
//     relay box, so the menu is no way around it);
//   * structured only: {action, target} -> one exact line "<cmd> <login>" built here (no free text, no flags);
//   * the target is in the room's roster, and for 👀 / 🔥 their cam is OPEN (Pepe's roster says on_cam) - Pepe checks it
//     again before the echo, so nothing is charged for a closed cam.
// Pepe's snapshot says per room what each action costs a member and whether it's switched on (R.pepe:
// {look|camroast|roast: {on, price, why?}}); the browser shows the price and asks before it sends. Pepe charges it
// (admins free) - the site never moves PAT here. The answer comes back in the job (padmod-style polling).
// 1.99?? (privacy controls, round 3 - F2; owner Q4: every cam feature works for an incognito person's cam under the frog name): 👀 / 🔥 on
// a FROG-NAME cam, picked by its opaque id ({action, id} - a people-list entry "v-…" or a mic-stage tile "anon-…", incogcams.refOf: only
// while incognito cams are in effect, their open frog-name session, on cam) and only while the person's own cam rules let this viewer
// see it (camviewers.camRefusal, strict - no 👻 bypass). The line Pepe runs is the usual "<cmd> <login>" (the Camfrog room sees what it
// sees today - incognito is about the bridge); the job also carries `veil: {alias}` so Pepe words every copy that comes back by the frog
// name, and everything the website gets - the answer to this request, the job's line / reply / replies, the command log a member can
// download - names the frog, never the login (masked here too: the login, the display name and its words). 🎤 !roast never goes by id
// (it's about the person, not the cam).
"use strict";
const express = require("express");
const { getQuery } = require("./dbUtils");
const guard = require("./middleware/authGuard");
const relay = require("./bridge-relay");

const ACTIONS = Object.freeze({ look: "!look", camroast: "!camroast", roast: "!roast" });
const CAM_ACTIONS = new Set(["look", "camroast"]);
const TARGET_RE = /^[A-Za-z0-9_.][\w.\-]{0,39}$/;
const WHY_MAX = 80;

/** Pepe's snapshot `pepe` -> {action: {on, price, why}} (unknown / malformed dropped; {} = off). */
function cleanMenu(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const a of Object.keys(ACTIONS)) {
    const v = raw[a];
    if (!v || typeof v !== "object") continue;
    const price = Math.max(0, Math.min(1e9, Math.floor(Number(v.price) || 0)));
    out[a] = { on: v.on === true, price };
    if (v.on !== true && v.why) out[a].why = relay.clean(v.why, WHY_MAX);
  }
  return out;
}

/** {action, target} -> {line} or {error}. The only way a click becomes a command line. */
function buildLine(action, target) {
  const a = typeof action === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, action) ? action : null;
  if (!a) return { error: "Unknown action." };
  const who = String(target == null ? "" : target).trim().replace(/^@/, "");
  if (!TARGET_RE.test(who)) return { error: "Pick someone from the room." };
  return { line: `${ACTIONS[a]} ${who}`, action: a, target: who };
}

/** The live room's member for `login` (case-insensitive), or null. */
function memberOf(R, login) {
  const l = String(login || "").toLowerCase();
  return (Array.isArray(R && R.members) ? R.members : []).find((m) => m && !m.anon && String(m.login || "").toLowerCase() === l) || null;
}

/** null = may send, else {status, error}. Pure (tests pin it): the room, the menu, the target. `veiled` (1.99?? round 3 - F2): the target
 *  is a frog-name cam veiledCam already found on cam - no by-login roster check (an incognito person has no named entry). */
function refusal(R, action, target, { veiled = false } = {}) {
  const menu = (R && R.pepe) || {};
  const cmds = (R && R.cmds) || {};
  const it = menu[action];
  if (!R || !R.relay || !Object.keys(cmds).length) return { status: 403, error: "Commands from the website aren't on in this Camfrog room." };
  if (!it || !(ACTIONS[action] in cmds)) return { status: 403, error: "Pepe doesn't offer that here." };
  if (!it.on) return { status: 403, error: "That's switched off in this room" + (it.why ? ` (${it.why})` : "") + "." };
  if (veiled) return CAM_ACTIONS.has(action) ? null : { status: 400, error: "Pick a person, not Pepe or a room bot." };
  const m = memberOf(R, target);
  if (!m) return { status: 404, error: "They're not in the room right now." };
  if (m.self || m.bot) return { status: 400, error: "Pick a person, not Pepe or a room bot." };
  if (CAM_ACTIONS.has(action) && m.on_cam !== true) return { status: 409, error: "Their cam isn't open - nothing was charged." };
  return null;              // yourself included: you pay like anyone (Pepe admins are free)
}

// ── 1.99?? (privacy controls, round 3 - F2): a frog-name cam by its opaque id ──
const VREF_RE = /^(?:v-[A-Za-z0-9_-]{12}|anon-[0-9a-f]{8})$/;
const UNAVAILABLE = "That cam isn't available right now - nothing was charged.";
/** A frog-name cam this viewer may act on -> {login, alias, display} (server-only) | null: incognito cams in effect, the person's open
 *  frog-name session, on cam (incogcams.refOf), and their own cam rules let this viewer see it (strict: no 👻 bypass). */
async function veiledCam(R, ref, userId) {
  if (!R || typeof ref !== "string" || !VREF_RE.test(ref)) return null;
  let V = null, IC = null;
  try { IC = require("./incogcams"); V = IC.refOf(R, ref); } catch (e) { V = null; }
  if (!V || !V.login || V.onCam !== true) return null;
  try { if (await require("./camviewers").camRefusal(V.login, userId, { strict: true })) return null; } catch (e) { return null; }
  const e = (R.members || []).find((x) => x && x.anon && x.id === V.id && x._vz);
  return { login: String(V.login).toLowerCase(), alias: IC.labelOf(V), display: e && e._vz && e._vz.display ? String(e._vz.display) : null };
}
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** -> (text) => text with every name of the person behind a frog-name cam (the login, the display name and its words of 4+ letters)
 *  swapped for the frog name - the site's own pass over what Pepe sends back (he masks it too). */
function maskOf(alias, names) {
  const a = String(alias || "someone");
  const all = new Set();
  for (const n of names || []) {
    const t = String(n == null ? "" : n).replace(/\s+/g, " ").trim();
    if (!t) continue;
    all.add(t.toLowerCase());
    for (const w of t.match(/\p{L}{4,}/gu) || []) all.add(w.toLowerCase());
  }
  const list = [...all].filter((n) => n.length >= 2 && n !== a.toLowerCase()).sort((x, y) => y.length - x.length);
  if (!list.length) return (s) => String(s == null ? "" : s);
  const rx = new RegExp("(?<![\\p{L}\\p{N}_])@?(?:" + list.map(escRx).join("|") + ")(?![\\p{L}\\p{N}_])", "giu");
  return (s) => String(s == null ? "" : s).replace(rx, () => a);
}

function register(app, { addUser, bySlug, isLive }) {
  const bad = (res, st, error) => res.status(st).json({ ok: false, error });
  app.post("/api/rooms/:slug/pepe", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return bad(res, 400, "Bad request.");
    if (!req.user || !req.user.userId) return bad(res, 401, "Sign in first.");
    const u = (await getQuery("SELECT userId, username, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!u) return bad(res, 401, "Sign in first.");
    const R = bySlug(req.params.slug);
    if (!R || !isLive(R)) return bad(res, 404, "That Camfrog room isn't live right now.");
    if (require("./adultgate").refuseJson(req, res, R.id)) return;            // adultgate site: the 18+ gate on this room
    if (!u.camfrogUsername) {
      // 1.99wv (connections audit C): a PATV account with no chat login runs the menu as itself (Pepe charges the account and
      // echoes "🌐 <PATV username> (PATV web)"); the same account rules as a relayed line (bridge-relay.accountRefusal)
      const why = await relay.accountRefusal(u, R, "");
      if (why) return bad(res, why.status, why.error);
    }
    // 1.99xa: an account a room mod / admin blocked from the web relay (bridgeblocks.js) can't drive Pepe into the room either
    const blk = await require("./bridgeblocks").refusal(R.id, u.userId, "commands").catch(() => null);   // 1.99zf: the commands feature
    if (blk) return bad(res, 403, blk);
    const b = req.body || {};
    // 1.99?? (privacy controls, round 3 - F2): {action, id} = a frog-name cam by its opaque id - resolved here, never answered
    let built, V = null;
    if (b.id != null && b.id !== "") {
      if (!(typeof b.action === "string" && CAM_ACTIONS.has(b.action))) return bad(res, 400, "Pick a person, not Pepe or a room bot.");
      V = await veiledCam(R, String(b.id).slice(0, 40), u.userId);
      if (!V) return bad(res, 409, UNAVAILABLE);
      built = buildLine(b.action, V.login);
      if (built.error) return bad(res, 409, UNAVAILABLE);
    } else built = buildLine(b.action, b.target);
    if (built.error) return bad(res, 400, built.error);
    const why = refusal(R, built.action, built.target, { veiled: !!V });
    if (why) return bad(res, why.status, why.error);
    const lim = relay.limited("cmd|" + u.userId, relay.CMD_GAP, relay.CMD_BURST, relay.CMD_WINDOW);
    if (lim) return bad(res, 429, lim);
    const shown = V ? `${ACTIONS[built.action]} ${V.alias}` : built.line;
    const j = relay.newJob({ kind: "cmd", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername || "",
      text: built.line, pepe: built.action, actor: require("./actorcap").actorOf(u), ...(V ? { veil: { alias: V.alias }, vshown: shown } : {}) });
    // (the mask lives on the job, not enumerable: nothing that copies a job's fields ever carries the names)
    if (V) Object.defineProperty(j, "vmask", { value: maskOf(V.alias, [V.login, V.display]), enumerable: false });
    console.log(`[padpepe] room=${R.id} account=${u.username} camfrog=${u.camfrogUsername} action=${built.action}${V ? " target=-" : ""} job=${j.id}`);
    relay.cmdLog({ userId: u.userId, username: u.username, camfrog: u.camfrogUsername, room: R.id,
      command: shown + " [pepe menu]", job: j.id, status: "pending", result: "" });
    res.json({ ok: true, id: j.id, line: shown, price: (R.pepe[built.action] || {}).price || 0 });
  });

  // one of MY menu jobs: state + Pepe's answer (his public reply is copied for the menu, late ones included)
  app.get("/api/rooms/:slug/pepe/job/:id", addUser, (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return bad(res, 401, "Sign in first.");
    const j = relay._jobs.get(String(req.params.id || ""));
    if (!j || j.userId !== req.user.userId || !j.pepe) return bad(res, 404, "No such request (they expire after a few minutes).");
    if (require("./adultgate").refuseJson(req, res, j.roomId)) return;        // adultgate site: Pepe's answer is about that room
    const r = j.result || {};
    res.json({ ok: true, state: j.state === "done" ? "done" : j.state === "claimed" ? "running" : "pending", done: j.state === "done",
      success: j.state === "done" ? !!r.ok : null, msg: r.msg || "", replies: r.replies || [], line: j.vshown || j.text });   // (F2: the frog's line)
  });
}

module.exports = { register, cleanMenu, buildLine, refusal, memberOf, ACTIONS, CAM_ACTIONS, veiledCam, maskOf };
