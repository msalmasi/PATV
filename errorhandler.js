// errorhandler.js - 1.99anw (review): the last Express handler, for an error that a middleware or a route passed on with next(err).
// index.js installs it after its 404 handler, and the Twitch webhook app (twitchbot/channelpoints.js webhookApp) installs it too.
//
// Why: without it Express's own finalhandler answers. Unless NODE_ENV=production, finalhandler's page is the error's stack, with
// the server's absolute paths in it. Nothing in the repo sets NODE_ENV for pm2. Anyone could trigger it without signing in: a JSON
// body of '{', more than 1000 form parameters, a JSON body over 100 KB, a bad gzip body. The status is kept (400, 413, 415 ...),
// and the answer is only the status's name: JSON for /api/, plain text elsewhere. The error's message and stack never reach the
// client. A 5xx is logged as the method, the path (no query string) and the message.
"use strict";
const http = require("http");

/** A JSON answer for /api/ (the 404 handler's rule), or when the client asked for JSON first. */
function wantsJson(req) {
  if (String(req.path || "").startsWith("/api/")) return true;
  try { return req.accepts(["html", "json"]) === "json"; } catch (_) { return false; }
}

function errorHandler(opts = {}) {
  const log = opts.log || console;
  return function siteErrorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);   // half-sent: Express's handler closes the connection
    let status = Number(err && (err.status || err.statusCode));
    if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
    if (status >= 500) {
      try { log.error(`[http] ${req.method} ${req.path}: ${status} ${(err && err.message) || String(err)}`); } catch (_) { /* never throw here */ }
    }
    const text = http.STATUS_CODES[status] || "Error";
    try {
      res.status(status).set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      if (wantsJson(req)) return res.json({ ok: false, error: text });
      return res.type("text/plain; charset=utf-8").send(text);
    } catch (_) {
      try { res.end(); } catch (__) { /* gone */ }
    }
  };
}

module.exports = { errorHandler, wantsJson };
