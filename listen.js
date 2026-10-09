// listen.js — where the site's HTTP servers listen (1.99cf).
//
// Loopback only by default: the public way in is nginx (80/443, behind Cloudflare), which proxies to
// http://localhost:<port>. Listening on every interface let anyone hit <public IP>:3000 / :3100 directly,
// skipping nginx and Cloudflare and choosing their own CF-Connecting-IP / X-Forwarded-For.
//
//   BIND_HOST unset  -> 127.0.0.1, plus [::1] (best effort) because nginx's "localhost" upstream resolves to
//                       both; without it nginx would try [::1] first, log a refused connection and fail over.
//   BIND_HOST=x      -> exactly x (e.g. 0.0.0.0 to undo this; not recommended).
"use strict";
const http = require("http");

function bindHost() {
  return process.env.BIND_HOST || "127.0.0.1";
}

/** app.listen on the bind host (+ [::1] when defaulted). cb runs once, for the main server. -> [servers] */
function listen(app, port, label, cb) {
  const explicit = !!process.env.BIND_HOST;
  const main = app.listen(port, bindHost(), cb);
  const servers = [main];
  if (!explicit) {
    const s6 = http.createServer(app);
    s6.on("error", (e) => console.warn(`[${label || "http"}] not listening on [::1]:${port} (${e.code || e.message}); 127.0.0.1 only`));
    main.once("listening", () => s6.listen({ port: main.address().port, host: "::1", ipv6Only: true }));
    servers.push(s6);
  }
  // 1.99gd: stop accepting on SIGINT/SIGTERM while the open requests finish (see shutdown.js)
  for (const s of servers) require("./shutdown").addServer(s);
  return servers;
}

module.exports = { listen, bindHost };
