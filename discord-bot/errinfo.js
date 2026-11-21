// errinfo.js - 1.99aou: what the Discord bot may log about a failed request or a Discord / site error.
//
// An AxiosError carries its request config - the headers (X-Bot-Token, X-PATV-Key, Authorization) and the request body
// (a bot token in "password") - and console.error(error) prints all of it. errInfo(e) is the one line to log instead:
//   * an error with a response (axios): "HTTP <status> <the answer's body, at most 300 characters>";
//   * anything else: "<code> <message>" (at most 300 characters), plus " (cause: <code> <message>)" when fetch's
//     "fetch failed" keeps the reason in .cause (at most 120 characters, the cause's code and message only);
//   * never the config, the headers, the request or the request body.
// The same output as the site's processguard.js errInfo for these shapes (test/discord-errinfo.test.js compares them). The
// Discord bot keeps its own copy so it loads none of the site's files (a site file change doesn't restart this bot).
"use strict";

const MAX = 300;                       // characters of the answer / of the code + message
const CAUSE_MAX = 120;                 // characters of the cause's code + message

/** An error's cause as "<code> <message>" (bounded; "" when none / not an object / unreadable) - never the cause object. */
function causeText(e) {
  try {
    const c = e && typeof e === "object" ? e.cause : null;
    if (!c || typeof c !== "object") return "";
    return [c.code, c.message].filter((v) => (typeof v === "string" || typeof v === "number") && String(v))
      .map(String).join(" ").replace(/[\r\n]+/g, " ").slice(0, CAUSE_MAX);
  } catch (x) { return ""; }
}

/** What may be logged about an error: the status and the answer's body for an HTTP error, else code + message. */
function errInfo(e) {
  if (!e || typeof e !== "object") return String(e);
  const r = e.response;
  if (r && typeof r === "object") {
    let data = r.data;
    try { data = typeof data === "string" ? data : JSON.stringify(data); } catch (x) { data = "[unreadable]"; }
    return `HTTP ${r.status}${data ? " " + String(data).slice(0, MAX) : ""}`;
  }
  const main = [e.code, e.message].filter(Boolean).join(" ").slice(0, MAX) || "error";
  const c = causeText(e);
  return c && !main.includes(c) ? `${main} (cause: ${c})` : main;
}

module.exports = { errInfo };
