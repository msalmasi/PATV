// crawlers.js — 1.99aax: PATV is not for search engines or AI crawlers (the user's call, 2026-10-15).
//   * /robots.txt: every crawler is disallowed everywhere - except the LINK-PREVIEW fetchers (Discord, Telegram, X, Facebook /
//     iMessage, Slack, WhatsApp, LinkedIn, Reddit), so a PATV link pasted in a chat still shows its card (og: tags + /og/*.png).
//   * every response carries X-Robots-Tag: noindex, nofollow, noarchive - pages already in a search index drop out the next
//     time the engine looks (it has to be allowed to fetch them once to see that; robots.txt blocks the fetch, so a page
//     indexed before stays listed as a bare URL until it ages out - remove it in Google Search Console to speed it up).
// This only stops POLITE bots. Scrapers that ignore robots.txt are Cloudflare's job (Bot Fight Mode / Block AI bots) or a
// proof-of-work gate in front of the site (e.g. Anubis) - not this file.
// PATV_CRAWLERS=allow (env) turns all of this off: the old behaviour (no robots.txt, no header).
"use strict";

const PREVIEW_BOTS = ["Twitterbot", "facebookexternalhit", "Facebot", "Discordbot", "TelegramBot", "Slackbot", "Slackbot-LinkExpanding",
  "WhatsApp", "LinkedInBot", "redditbot"];
const HEADER = "noindex, nofollow, noarchive";

function robotsTxt() {
  const allow = PREVIEW_BOTS.map((b) => `User-agent: ${b}\nAllow: /\n`).join("\n");
  return `# PATV is a members' community, not a search result. Link previews are welcome; crawling and AI training are not.\n\n${allow}\nUser-agent: *\nDisallow: /\n`;
}

const enabled = () => String(process.env.PATV_CRAWLERS || "block").toLowerCase() !== "allow";

/** Before every other route: the header on everything, and /robots.txt. */
function register(app) {
  if (!enabled()) return;
  const body = robotsTxt();
  app.use((req, res, next) => {
    res.set("X-Robots-Tag", HEADER);
    if (req.path === "/robots.txt" && (req.method === "GET" || req.method === "HEAD")) {
      res.set({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      return res.send(body);
    }
    next();
  });
}

module.exports = { register, robotsTxt, enabled, PREVIEW_BOTS, HEADER };
