"use strict";
// Human-facing share links only; service and canonical URLs keep their own origin.
function activeBase() {
  if (process.env.STAGING || !process.env.SHORT_LINK_BASE) return "";
  try {
    const raw = process.env.SHORT_LINK_BASE.trim();
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash || !/^https:\/\/[^/?#\\\s]+\/?$/.test(raw)) return "";
    return u.origin;
  } catch (_) { return ""; }
}
function shareBase() {
  return activeBase() || String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL ||
    (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");
}
function shareUrl(path) { return shareBase() + "/" + String(path || "").replace(/^\/+/, ""); }
module.exports = { activeBase, shareBase, shareUrl };
