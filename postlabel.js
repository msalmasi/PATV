// postlabel.js - 1.99ex: the one way the site names a post. Never a "no title" placeholder.
//
// postLabel(p) -> string; labelOf(p) -> {text, fallback, level}. Fallback order:
//   1. its title
//   2. its link preview's title
//   3. the first ~10 words of its body, markup stripped, "…" when cut (pads.postSlug uses the same words)
//   4. what it is: "📌 Capture from <room>" (a story capture), "✨ AI picture by <author>", "🎬 Video by <author>",
//      "📷 Photo by <author>", "🔊 Audio by <author>"
//   5. "Post by <author>"
// A crosspost with no title of its own is named by its original. `fallback` is true from level 2 on: the HOT list
// and the cards show a fallback in a muted style (it describes the post rather than titling it).
// p: a decorated post (feedstore.decorate) or anything shaped like one ({title, body, link: {title}, images, video,
// audio, ai, capture: {room: {title}}, author: {display, username, bot}, xpost: {post}}). Plain text out (escape it).
"use strict";

const WORDS = 10;
// control characters + the two Unicode line separators (built from char codes so no raw separator sits in the source)
const CTRL_RE = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127, 0x2028, 0x2029) + "]+", "g");

/** Text without markup: tags, markdown markers, [text](url) -> text, bare URLs dropped, whitespace collapsed. */
function plain(s) {
  return String(s == null ? "" : s)
    .replace(/<[^>]*>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/(^|\s)[#>]+\s*/g, "$1")
    .replace(/[*_~`|]+/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " }[e]))
    .replace(CTRL_RE, " ")
    .replace(/\s+/g, " ").trim();
}
/** The first `n` words of a body (markup stripped). cut: true when there was more. */
function firstWords(s, n = WORDS) {
  const w = plain(s).split(" ").filter(Boolean);
  return { text: w.slice(0, n).join(" "), cut: w.length > n };
}
const line = (s, max = 200) => { const t = plain(s); return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t; };
const has = (a) => Array.isArray(a) && a.length > 0;
function authorOf(p) {
  const a = (p && p.author) || {};
  if (a.bot) return "Pepe";
  return line(a.display || a.username || "", 60) || "someone";
}

function labelOf(p) {
  if (!p) return { text: "Post", fallback: true, level: 5 };
  const own = line(p.title);
  if (own) return { text: own, fallback: false, level: 1 };
  const q = p.xpost && p.xpost.post ? p.xpost.post : p;       // a crosspost without its own title: the original
  if (q !== p) { const t = line(q.title); if (t) return { text: t, fallback: false, level: 1 }; }
  const lt = line(q.link && q.link.title);
  if (lt) return { text: lt, fallback: true, level: 2 };
  const fw = firstWords(q.body);
  if (fw.text) return { text: fw.text + (fw.cut ? "…" : ""), fallback: true, level: 3 };
  const by = authorOf(q.author ? q : p);
  if (q.capture && q.capture.room) return { text: `📌 Capture from ${line(q.capture.room.title || q.capture.room.id, 80) || "a pad"}`, fallback: true, level: 4 };
  const ai = has(q.ai) && q.ai.some((a) => a.kind === "image" || a.kind == null);
  if (ai) return { text: `✨ AI picture by ${by}`, fallback: true, level: 4 };
  if (has(q.video)) return { text: `🎬 Video by ${by}`, fallback: true, level: 4 };
  if (has(q.images)) return { text: `📷 Photo by ${by}`, fallback: true, level: 4 };
  if (has(q.audio)) return { text: `🔊 Audio by ${by}`, fallback: true, level: 4 };
  return { text: `Post by ${by}`, fallback: true, level: 5 };
}
const postLabel = (p) => labelOf(p).text;

module.exports = { postLabel, labelOf, firstWords, plain, WORDS };
