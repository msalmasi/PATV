// shutdown.js — a graceful stop on SIGINT / SIGTERM (1.99gd).
//
// pm2 restarts the site with SIGINT (a deploy, `pm2 restart`) and SIGKILLs it ~1.6 s later. Before this, dbUtils
// closed the DB and exited at once, so every request still in flight was cut: above all Pepe's long-polls
// (POST /api/pepe/help/pull, /api/pepe/imagesafety/pull), which are ALWAYS in flight. nginx logged "upstream
// prematurely closed connection", answered 502 and parked the upstream for 10 s ("no live upstreams"), and staging
// Pepe's router took the 502 as "the site is down".
//
// Now a stop goes:  draining (the long-polls answer "no work" at once, new ones don't wait; the servers stop
//                   accepting) -> GRACE_MS later the exit hooks (dbUtils closes the DB) -> exit.
// A process with nothing registered to drain (the discord bots etc. that only load dbUtils) exits as before.
"use strict";

const GRACE_MS = 400;          // for the drained answers to be written (well under pm2's 1.6 s kill_timeout)
const HARD_MS = 1300;          // exit even if an exit hook never calls back

const drainHooks = [];         // () => void   - answer what's waiting
const exitHooks = [];          // (done) => void - close things; call done()
const servers = [];
let draining = false;
let installed = false;
let EXIT = (code) => process.exit(code);

function install() {
  if (installed) return;
  installed = true;
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

/** Something to answer at once when the process starts stopping (pending long-polls). */
function onDrain(fn) { drainHooks.push(fn); install(); }
/** Something to close last; fn(done). */
function onExit(fn) { exitHooks.push(fn); install(); }
/** An http.Server to stop accepting on (open requests still finish). */
function addServer(s) { if (s) servers.push(s); install(); }
function isDraining() { return draining; }

function finish() {
  let left = exitHooks.length;
  const done = () => { if (--left <= 0) EXIT(0); };
  if (!left) return EXIT(0);
  for (const fn of exitHooks) { try { fn(done); } catch (e) { done(); } }
}

function stop(signal) {
  if (draining) return;
  draining = true;
  const graceful = drainHooks.length > 0 || servers.length > 0;
  if (graceful) console.log(`[shutdown] ${signal}: draining (long-polls answered, no new connections)`);
  for (const fn of drainHooks) { try { fn(); } catch (e) { /* keep going */ } }
  for (const s of servers) {
    try { s.close(); } catch (e) { /* not listening */ }
    try { if (typeof s.closeIdleConnections === "function") s.closeIdleConnections(); } catch (e) { /* old node */ }
  }
  setTimeout(() => EXIT(0), HARD_MS).unref();
  if (graceful) setTimeout(finish, GRACE_MS);
  else finish();
}

function _reset() { draining = false; }
function _setExit(fn) { EXIT = fn; }

module.exports = { onDrain, onExit, addServer, isDraining, stop, GRACE_MS, HARD_MS, _reset, _setExit };
