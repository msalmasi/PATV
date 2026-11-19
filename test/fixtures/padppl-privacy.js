// 1.99ajn padppl: the privacy page's always-current additions, taken out (or put back) before a golden comparison with an older commit.
// They are the current text for everyone, not behind a switch: section 6's "Blocking someone" paragraph (blocks.js; dated by terms.js
// "blocks-2") and, inside the privacy wire v2 text, the incognito bullet's mention sentence (mentions.js: an incognito @mention can alert
// the person it names, under the frog name; dated by "chat-mentions"). Everything else padppl adds is behind a switch or a dated note.
// 1.99aot gifs: + the GIFs (KLIPY) text, also always shown (owner-approved 2026-11-19): section 7's bullet, section 3's "GIFs in the chat",
// section 9's two rows and section 14's dated note - each one whole line of its own (gifsOut).
"use strict";
const NEW_MENTION = "Anything you say may be shown or quoted under that frog name, never your name; an @mention you make can alert the person you name, under your frog name, never your name.";
const OLD_MENTION = "Anything you say may be shown or quoted under that frog name, never your name, and it doesn't turn up as mentions.";
/** The page without 1.99aot's GIFs (KLIPY) lines. */
function gifsOut(page) {
  return String(page).replace(/[ \t]*<li id="gifs-klipy">[^\n]*<\/li>\r?\n/, "").replace(/[ \t]*<p id="gifs-chat">[^\n]*<\/p>\r?\n/, "")
    .replace(/[ \t]*<tr id="gifs-notice-row">[^\n]*<\/tr>\r?\n/, "").replace(/[ \t]*<tr id="gifs-blocks-row">[^\n]*<\/tr>\r?\n/, "")
    .replace(/[ \t]*<li id="gifs-change">[^\n]*<\/li>\r?\n/, "");
}
/** The page as the build before padppl rendered it. */
function before(page) {
  return gifsOut(page).replace(/[ \t]*<p id="blocking">[\s\S]*?<\/p>\r?\n/, "").split(NEW_MENTION).join(OLD_MENTION);
}
module.exports = { before, gifsOut, NEW_MENTION, OLD_MENTION };
