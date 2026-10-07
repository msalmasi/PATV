// dmembeds.js — PATV post cards inside direct messages (1.99cz). A message that contains a link to a feed post
// (https://publicaccess.tv/feed/p/<id>, also www. / staging. / this server's SITE_URL host) gets a compact card:
// pad, title, author, score, comments and a thumbnail, linking to the post. "Share -> Send in a message" on a post
// (/messages?share=<id>) just puts that link in the composer.
//
// Visibility is decided when the message is SHOWN (not when it was sent), with the feed's own rules:
//   * deleted, hidden (reports / admin) or not live in any of its pads (removed / pending / hidden there)
//     -> "Post unavailable" - no title, author or picture, for everyone (staff included: a DM isn't the mod view)
//   * NSFW (the author's mark, an admin's, or a pad's) -> the card shows, its thumbnail blurred until clicked
//   * a crosspost shows its original; if the original is gone, it's unavailable
// The thumbnail is the post's public feed file (/feed/f/...), which applies its own rules again.
"use strict";

const MAX_PER_MESSAGE = 3;
const POST_ID = "[A-Za-z0-9]{8,16}";
const KNOWN = new Set(["publicaccess.tv", "www.publicaccess.tv", "staging.publicaccess.tv"]);
function hosts() {
  const h = new Set(KNOWN);
  try { if (process.env.SITE_URL) h.add(new URL(process.env.SITE_URL).host.toLowerCase()); } catch (e) { /* bad env */ }
  for (const x of String(process.env.DM_EMBED_HOSTS || "").split(",")) if (x.trim()) h.add(x.trim().toLowerCase());
  return h;
}
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]{2,500}/gi;
/** The post ids linked in a message body (in order, de-duplicated, at most MAX_PER_MESSAGE). */
function postIds(body) {
  const out = [];
  const H = hosts();
  const s = String(body || "");
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(s)) && out.length < MAX_PER_MESSAGE) {
    let u;
    try { u = new URL(m[0].replace(/[).,;:!?\]}]+$/, "")); } catch (e) { continue; }
    if (!H.has(u.host.toLowerCase())) continue;
    const p = new RegExp("^/feed/p/(" + POST_ID + ")/?$").exec(u.pathname);
    if (p && !out.includes(p[1])) out.push(p[1]);
  }
  return out;
}

let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }
const cache = new Map();          // id -> {at, v}
const TTL = 30e3;
function _clear() { cache.clear(); }

/** One post's card for a DM. -> {id, href, unavailable} | {id, href, title, author, pad, score, comments, thumb, nsfw} */
async function card(id) {
  const hit = cache.get(id);
  if (hit && NOW() - hit.at < TTL) return hit.v;
  const store = require("./feedstore");
  const href = "/feed/p/" + id;
  let v = { id, href, unavailable: true };
  try {
    const p = await store.get(id, null);
    const live = (q) => !!q && !q.deleted && !q.hidden && q.roomsAll.some((r) => !r.removed && !r.pending && !r.hidden);
    const xGone = p && p.xpost && (!p.xpost.post || p.xpost.removed);
    if (live(p) && !xGone) {
      const q = p.xpost ? p.xpost.post : p;
      const room = p.roomsAll.find((r) => !r.removed && !r.pending && !r.hidden);
      const thumb = store.thumbOf ? store.thumbOf(p) : null;
      v = {
        id, href, unavailable: false,
        title: (p.title || q.title || (q.link && q.link.title) || "").slice(0, 140) || (q.body ? String(q.body).replace(/\s+/g, " ").slice(0, 100) : "Post"),
        author: p.author ? { username: p.author.username, display: p.author.display } : null,
        pad: room ? { title: room.title, slug: room.slug } : null,
        score: p.score || 0, comments: p.comments || 0, nsfw: !!p.nsfw,
        thumb: thumb && /^[a-f0-9]{32}(?:_t|_p)?\.webp$/.test(thumb) ? "/feed/f/" + thumb : null,
      };
    }
  } catch (e) { console.error("[dm] embed:", e && e.message); }
  cache.set(id, { at: NOW(), v });
  if (cache.size > 2000) cache.clear();
  return v;
}

/** The cards for one message body. */
async function forBody(body) {
  const ids = postIds(body);
  const out = [];
  for (const id of ids) out.push(await card(id));
  return out;
}

module.exports = { postIds, card, forBody, MAX_PER_MESSAGE, _setClock, _clear };
