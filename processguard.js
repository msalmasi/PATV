// processguard.js — 1.99anx: the process-wide last resort for an unhandled promise rejection / an uncaught exception, shared by
// the website (index.js, pm2 'index', port 3000) and the Twitch webhook server (server.js, pm2 'server').
//
// Why (owner, 2026-11-14: "the main site should get the catch-all crash guard the Twitch webhook server already has"): on Node 22
// an unhandled rejection anywhere in index.js - one request's forgotten .catch, one timer's tick - ends the WHOLE site. pm2
// restarts it, every open request and long-poll is cut, and if it happens inside the prod updater's post-deploy check
// (deploy/patv-update.sh: /healthz polled every 3 s, then STABLE_SECS = 30 s during which pm2's restart count must not move) the
// deploy is rolled back and the commit marked bad for good - for one failing request. Node also prints the whole error object:
// an AxiosError's config carries its headers (X-Bot-Token, X-PATV-Key, Authorization) and its request body into the log.
// server.js has had this guard since 1.99afh (twitchbot/channelpoints.js guardProcess); it lives here now, and channelpoints.js
// re-exports guardProcess / errInfo / frames for its callers (twitch.js, server.js, test/twitch-channelpoints.test.js).
//
//   guardProcess(process, {label, bootFatal})   install once per process (process.__patvGuarded); -> process
//   ready(process)                              index.js's listen callback: the site is up (starts the settle window)
//   errInfo(e) / frames(e)                      what may be logged about an error (below)
//   where(e) / isAppFrame(line)                 the frames the guard prints: the top one + the site's own (below)
//
// What it does
//   * unhandled rejection -> one log line "[<label>] unhandled rejection (kept running): <errInfo> @ <frames>" and the process
//     KEEPS RUNNING (a rejection is one async job that failed; the event loop and every other request are fine);
//   * uncaught exception  -> logged the same way, then exit(1) as Node would (pm2 restarts it): after a synchronous throw that
//     nothing caught, the state of whatever was running (a half-written structure, a lock held, a stream half-read) is not
//     trustworthy, so the process is not kept;
//   * the log line is errInfo + frames ONLY: the status and the answer's body for an HTTP error, else code + message (each
//     bounded to 300 characters) and the cause's code + message (below), then the stack's "at ..." frames (where(), below).
//     Never the error object, so never an AxiosError's config / headers / request, never a request body. The handlers never throw.
//   * the cause (1.99anx review G2): Node 22's fetch (undici) rejects with TypeError "fetch failed" and puts the reason in .cause
//     (ECONNREFUSED, ENOTFOUND, a certificate error, "other side closed"). errInfo adds " (cause: <code> <message>)", at most
//     CAUSE_MAX (120) characters, from the cause's code and message only - never the cause object; nothing when the message
//     already says it (an AxiosError's network cause repeats it). Node's own crash print showed the cause; without it every
//     fetch failure in the site read the same;
//   * the frames (review G1): an axios / fetch failure's top frames are the library's (axios's settle, handleStreamEnd, emit,
//     ..., undici's internals) and the site's own caller ("at async telegramSend") is frame 7 or later. where() prints the top
//     frame (where it was thrown), the first APP_FRAMES (3) frames of the site's own code wherever they are (isAppFrame: a
//     file:line:col outside node_modules/ and node: internals), then the next top frames - 6 in all, in stack order, "..."
//     where frames were left out. A stack of the site's own code prints exactly its top 6, as before.
//
// BOOT (bootFatal: index.js only) - an unhandled rejection is still FATAL (logged, exit 1) until the site is listening and
// SETTLE_MS (10 s) after that:
//   Before this guard, a rejection during startup (the schema / migration work kicked off as modules load, a module's async
//   setup, one of index.js's startup jobs) crashed the site, pm2 restarted it into the same crash, and the updater rolled the
//   deploy back. That is the right outcome for a deploy that cannot start. Swallowing it would leave a HALF-STARTED site serving -
//   and /healthz (a SELECT 1) would still answer 200, so the updater would keep the bad commit. So during boot the behaviour is
//   exactly what it was (plus a clean log line); prod runs today without boot crashes, so this changes nothing for a good deploy.
//   Why "listening + 10 s": index.js registers every route synchronously while it loads, and only listens once funding.init()
//   settled (raced against 10 s). Its startup jobs are scheduled while it loads - setTimeouts 2 / 3 / 3.5 / 8 s after load, the
//   schema chains (createTables, the modules' ensure()) start at load - so they have run, or run within ~8 s of the listen
//   callback; 10 s is that plus margin. It also ends well inside the updater's check (first /healthz answer, then 30 s stable),
//   so a boot fault still restarts the site where the updater sees it and rolls back. After it, a rejection is a runtime fault of
//   one request / tick: logged and survived, so one failing request in those 30 s no longer rolls back a good deploy.
//   Later maintenance jobs (cosmetics / user.controller backfills at 15 s, welcome's at 20 s) run on a site that is up, catch
//   their own errors, and are survived like any runtime rejection. listen itself failing (EADDRINUSE) is an 'error' event with
//   no listener = an uncaught exception = exit 1. If ready() never comes, rejections stay fatal: the site never started.
//   server.js passes no bootFatal (as since 1.99afh): its startup talks to Twitch and the site, and a site that is down must not
//   stop the chat bot (test/twitch-bot-errors.test.js boots it that way).
//
// THROTTLE - a rejection in a hot path (every request, every tick) must not flood index-error.log:
//   * the same signature (code + name + status + message + the cause's code + the top frame and the first app frame) is printed
//     at most once per SAME_MS (60 s) - two call sites that fail the same way inside axios / fetch are two signatures (review G1);
//     an HTTP answer's body is not part of it (it may carry an id / a time: one hot path stays one signature). The ones in
//     between are counted, and reported either on that signature's next printed line ("(+k more since 75 s ago)") or, when it
//     doesn't come back, by a summary line once its 60 s are up ("repeated k more times in the last 60 s ... @ <those frames>");
//   * at most CAP_PER_MIN (10) lines a minute in all (a fixed 60 s window); past it the rejections are only counted, and ONE
//     line a minute says how many were not logged ("rate cap"). A signature's pending count that can't be printed under the cap
//     moves into that count - every rejection is either printed or counted, never silently lost;
//   * at most MAX_SIGS (500) signatures are remembered (oldest dropped; a dropped one's pending count moves to the cap count);
//   * the summary timer is unref'd (it never keeps a process alive) and runs only while something is pending;
//   * an uncaught exception, the startup-fatal line and the exit's "k not logged" line are never throttled (each ends the process).
// Worst case: 10 lines + 1 summary a minute, each at most MAX_LINE (2000) characters.
//
// No npm dependencies (server.js's twitchbot/ folder and the site both load it). Tests: test/processguard.test.js (unit + real
// child processes + the index.js pin), test/twitch-channelpoints.test.js (server.js's guard).
"use strict";

const SETTLE_MS = 10 * 1000;          // boot: still fatal this long after ready()
const SAME_MS = 60 * 1000;            // one signature: at most one printed line per minute
const CAP_PER_MIN = 10;               // all signatures: at most 10 printed lines per minute (+ one "not logged" line)
const MAX_SIGS = 500;                 // signatures remembered
const MAX_LINE = 2000;                // characters in one log line
const APP_FRAMES = 3;                 // where(): the site's own frames printed, wherever they are in the stack
const CAUSE_MAX = 120;                // errInfo: characters of the cause's code + message

/** An error's cause as "<code> <message>" (bounded; "" when none / not an object / unreadable) - never the cause object. */
function causeText(e) {
  try {
    const c = e && typeof e === "object" ? e.cause : null;
    if (!c || typeof c !== "object") return "";
    return [c.code, c.message].filter((v) => (typeof v === "string" || typeof v === "number") && String(v))
      .map(String).join(" ").replace(/[\r\n]+/g, " ").slice(0, CAUSE_MAX);
  } catch (x) { return ""; }
}

/** What may be logged about a failed request: the status and the answer's body - never config / headers / the request.
 *  Anything else: code + message, and the cause's code + message when it says more (fetch's "fetch failed"). */
function errInfo(e) {
  if (!e || typeof e !== "object") return String(e);
  const r = e.response;
  if (r && typeof r === "object") {
    let data = r.data;
    try { data = typeof data === "string" ? data : JSON.stringify(data); } catch (x) { data = "[unreadable]"; }
    return `HTTP ${r.status}${data ? " " + String(data).slice(0, 300) : ""}`;
  }
  const main = [e.code, e.message].filter(Boolean).join(" ").slice(0, 300) || "error";
  const c = causeText(e);
  return c && !main.includes(c) ? `${main} (cause: ${c})` : main;
}

/** The stack's "at ..." lines, trimmed (never the first line's message, never the object). */
function stackFrames(e) {
  const s = e && typeof e === "object" && typeof e.stack === "string" ? e.stack : "";
  return s.split("\n").filter((l) => /^\s+at /.test(l)).map((l) => l.trim());
}

/** Where an error happened: its stack's top n "at ..." frames only (never the first line's message, never the object). */
function frames(e, n = 6) {
  return stackFrames(e).slice(0, n).join(" | ");
}

/** A frame of the site's own code: a file:line:col that isn't in node_modules/ and isn't a node: / internal one. */
function isAppFrame(line) {
  const l = String(line || "").trim();
  const m = /\(([^()]*)\)$/.exec(l);
  const loc = m ? m[1] : ((/^at (?:async )?(\S+)$/.exec(l) || [])[1] || "");
  return /:\d+:\d+$/.test(loc) && !/(^|[\\/])node_modules[\\/]|^node:|^internal[\\/]|^<anonymous>/.test(loc);
}

/**
 * The frames the guard prints: the top one (where it was thrown), the first `apps` app frames (isAppFrame) wherever they are,
 * then (fill) the next top frames - at most n, in stack order, "..." where frames were left out. A stack of the site's own code
 * prints exactly as frames(e, n) does; an axios / fetch failure also shows the site's caller.
 */
function where(e, n = 6, apps = APP_FRAMES, fill = true) {
  const all = stackFrames(e);
  if (!all.length) return "";
  const keep = new Set([0]);
  for (let i = 0, k = 0; i < all.length && k < apps && keep.size < n; i++) if (isAppFrame(all[i])) { keep.add(i); k++; }
  if (fill) for (let i = 0; i < all.length && keep.size < n; i++) keep.add(i);
  const out = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) { if (i > prev + 1) out.push("..."); out.push(all[i]); prev = i; }
  return out.join(" | ");
}

/** errInfo / frames that never throw (a getter on a hostile object, a Proxy). */
function safe(fn, dflt) { try { return fn(); } catch (x) { return dflt; } }
const infoOf = (e) => safe(() => errInfo(e), "[unreadable error]");
const at = (e) => { const f = safe(() => where(e), "").slice(0, 1500); return f ? " @ " + f : ""; };
/** The signature's / a summary line's location: the top frame + the first app frame ("..." between; one frame when they're one). */
const topOf = (e) => safe(() => where(e, 2, 1, false), "");

/** The throttle's key: code + name + status + message + the cause's code + topOf (an HTTP answer's body is left out - it may
 *  carry an id / a time - so one hot path stays one signature; two call sites failing inside axios are two). */
function signature(e) {
  return safe(() => {
    if (!e || typeof e !== "object") return "v|" + String(e).slice(0, 200);
    const msg = typeof e.message === "string" ? e.message.slice(0, 200) : "";
    const status = e.response && typeof e.response === "object" ? String(e.response.status) : "";
    const cause = safe(() => (e.cause && typeof e.cause === "object" && e.cause.code != null ? String(e.cause.code).slice(0, 40) : ""), "");
    return ["o", e.code || "", e.name || "", status, msg, cause, topOf(e)].join("|");
  }, "?");
}

const monoNow = () => Number(process.hrtime.bigint() / 1000000n);
const unrefTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === "function") t.unref(); return t; };
const secs = (ms) => Math.max(0, Math.round(ms / 1000));

/**
 * The guard's logic, without a process (tests drive it). opts:
 *   label      the log prefix: "[<label>] ..." ("site" for index.js, "server" for server.js)
 *   bootFatal  true: an unhandled rejection exits 1 until ready() + settleMs (index.js)
 *   warn, exit, now (ms, monotonic), setTimer(fn, ms) - tests; settleMs, sameMs, capPerMin, maxSigs - tests
 */
function createGuard(opts = {}) {
  const label = String(opts.label || "process").replace(/[^\w.-]/g, "").slice(0, 32) || "process";
  const P = `[${label}]`;
  const warn = opts.warn || ((line) => console.error(line));
  const exit = opts.exit || ((code) => process.exit(code));
  const now = opts.now || monoNow;
  const setTimer = opts.setTimer || unrefTimer;
  const bootFatal = !!opts.bootFatal;
  const settleMs = opts.settleMs != null ? opts.settleMs : SETTLE_MS;
  const sameMs = opts.sameMs != null ? opts.sameMs : SAME_MS;
  const capPerMin = opts.capPerMin != null ? opts.capPerMin : CAP_PER_MIN;
  const maxSigs = opts.maxSigs != null ? opts.maxSigs : MAX_SIGS;

  const sigs = new Map();            // signature -> {last (ms), k (not printed since), info, top}
  let readyAt = null;
  let winStart = null, winCount = 0, overflow = 0, overflowSigs = new Set();
  let timer = null;
  const stats = { rejections: 0, printed: 0, fatal: 0, exceptions: 0 };

  const out = (line) => { try { warn(String(line).slice(0, MAX_LINE)); } catch (x) { /* never throw from here */ } };
  const inBoot = () => bootFatal && (readyAt === null || now() - readyAt < settleMs);

  /** The fixed one-minute window; when it rolls over, the "not logged" line for the minute that ended. */
  function roll(t) {
    if (winStart !== null && t - winStart < 60000) return;
    if (overflow > 0) {
      out(`${P} unhandled rejections: ${overflow} more not logged in the last minute (rate cap ${capPerMin} lines a minute; ` +
          `${overflowSigs.size} kind${overflowSigs.size === 1 ? "" : "s"}) - kept running`);
    }
    winStart = t; winCount = 0; overflow = 0; overflowSigs = new Set();
  }
  /** A line the cap allows? (counts it) */
  function allow(t) { roll(t); if (winCount >= capPerMin) return false; winCount++; stats.printed++; return true; }
  function toOverflow(sig, k) { if (k > 0) { overflow += k; if (overflowSigs.size < maxSigs) overflowSigs.add(sig); } }
  function remember(sig, e) {
    if (sigs.has(sig)) sigs.delete(sig);           // re-insert: Map order = least recently printed first
    sigs.set(sig, e);
    while (sigs.size > maxSigs) {
      const [oldSig, old] = sigs.entries().next().value;
      sigs.delete(oldSig);
      if (old.k > 0) { toOverflow(oldSig, old.k); schedule(); }
    }
  }
  function pending() { if (overflow > 0) return true; for (const e of sigs.values()) if (e.k > 0) return true; return false; }
  function schedule() {
    if (timer) return;
    try { timer = setTimer(() => { timer = null; flush(); }, sameMs); } catch (x) { timer = null; }
  }

  /** The summary lines that are due (a signature's 60 s are up, the minute's "not logged" count); reschedules while pending. */
  function flush() {
    try {
      const t = now();
      roll(t);
      for (const [sig, e] of sigs) {
        if (e.k > 0 && t - e.last >= sameMs) {
          if (allow(t)) {
            out(`${P} unhandled rejection repeated ${e.k} more time${e.k === 1 ? "" : "s"} in the last ${secs(t - e.last)} s ` +
                `(kept running; not logged one by one): ${e.info}${e.top ? " @ " + e.top : ""}`);
          } else toOverflow(sig, e.k);
          e.k = 0; e.last = t;                     // a new 60 s window for this signature
        }
      }
      if (pending()) schedule();
    } catch (x) { /* never throw from here */ }
  }

  function onRejection(reason) {
    try {
      stats.rejections++;
      if (inBoot()) {
        stats.fatal++;
        out(`${P} unhandled rejection during startup - exiting: ${infoOf(reason)}${at(reason)}`);
        try { exit(1); } catch (x) { /* never throw from here */ }
        return;
      }
      const t = now();
      const sig = signature(reason);
      const e = sigs.get(sig);
      if (e && t - e.last < sameMs) { e.k++; schedule(); return; }          // printed less than a minute ago: counted
      if (!allow(t)) { toOverflow(sig, 1); schedule(); return; }            // over the minute's cap: counted
      const more = e && e.k > 0 ? ` (+${e.k} more since ${secs(t - e.last)} s ago)` : "";
      out(`${P} unhandled rejection (kept running): ${infoOf(reason)}${at(reason)}${more}`);
      remember(sig, { last: t, k: 0, info: infoOf(reason), top: topOf(reason) });
    } catch (x) { /* never throw from here */ }
  }

  function onException(err) {
    try {
      stats.exceptions++;
      let lost = overflow;
      for (const e of sigs.values()) lost += e.k;
      if (lost > 0) out(`${P} (${lost} unhandled rejection${lost === 1 ? "" : "s"} since the last lines above were not logged one by one)`);
      out(`${P} uncaught exception - exiting: ${infoOf(err)}${at(err)}`);
    } catch (x) { /* never throw from here */ }
    try { exit(1); } catch (x) { /* never throw from here */ }
  }

  function ready() { if (readyAt === null) readyAt = now(); }

  return { label, onRejection, onException, ready, flush, inBoot, stats, _sigs: sigs };
}

/**
 * Install the guard on a process (once: the first call wins, later calls return at once). opts: see createGuard.
 * index.js: guardProcess(process, {label: "site", bootFatal: true}) as its first statement, ready(process) when it listens.
 */
function guardProcess(proc, opts = {}) {
  if (!proc || proc.__patvGuarded) return proc;
  const g = createGuard(Object.assign({}, opts, { exit: opts.exit || ((code) => proc.exit(code)) }));
  proc.__patvGuarded = true;
  try { Object.defineProperty(proc, "__patvGuard", { value: g, configurable: true, enumerable: false, writable: true }); }
  catch (x) { proc.__patvGuard = g; }
  proc.on("unhandledRejection", (reason) => g.onRejection(reason));
  proc.on("uncaughtException", (err) => g.onException(err));
  return proc;
}

/** The process is up (index.js: its listen callback): an unhandled rejection is survived SETTLE_MS from now. -> installed? */
function ready(proc = process) {
  const g = proc && proc.__patvGuard;
  if (!g) return false;
  try { g.ready(); } catch (x) { /* never throw from here */ }
  return true;
}

module.exports = { errInfo, frames, where, isAppFrame, signature, createGuard, guardProcess, ready,
                   SETTLE_MS, SAME_MS, CAP_PER_MIN, MAX_SIGS, MAX_LINE, APP_FRAMES, CAUSE_MAX };
