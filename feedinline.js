// feedinline.js — shared feed text pipeline, kept unchanged for legacy plain bodies.
// Markdown applies this only to literal text runs; code bypasses links, refs and stickers.
"use strict";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"'`]/g, (c) => ESC[c]);
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]{2,2000}/gi;
const padText = (t) => { const P = require("./pads"); return stickerHtml(require("./feedmentions").inlineRefs(P.userRefs(P.padRefs(esc(t))))); };
const stickerHtml = (h) => { try { return require("./stickers").inline(h); } catch (e) { return h; } };

function linkify(text) {
  const s = String(text == null ? "" : text);
  let out = "", last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    let url = m[0];
    const trail = url.match(/[).,;:!?\]}]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    out += padText(s.slice(last, m.index));
    let ok = false;
    try { const u = new URL(url); ok = u.protocol === "http:" || u.protocol === "https:"; } catch (e) { ok = false; }
    out += ok ? `<a href="${esc(url)}" rel="nofollow noopener noreferrer ugc" target="_blank">${esc(url.length > 80 ? url.slice(0, 77) + "…" : url)}</a>` : esc(url);
    last = m.index + url.length;
    URL_RE.lastIndex = last;
  }
  return out + padText(s.slice(last));
}

module.exports = { esc, linkify, padText, stickerHtml };
