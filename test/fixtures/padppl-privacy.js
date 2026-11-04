// 1.99?? padppl: the privacy page's always-current additions, taken out (or put back) before a golden comparison with an older commit.
// They are the current text for everyone, not behind a switch: section 6's "Blocking someone" paragraph (blocks.js; dated by terms.js
// "blocks-2") and, inside the privacy wire v2 text, the incognito bullet's mention sentence (mentions.js: an incognito @mention can alert
// the person it names, under the frog name; dated by "chat-mentions"). Everything else padppl adds is behind a switch or a dated note.
"use strict";
const NEW_MENTION = "Anything you say may be shown or quoted under that frog name, never your name; an @mention you make can alert the person you name, under your frog name, never your name.";
const OLD_MENTION = "Anything you say may be shown or quoted under that frog name, never your name, and it doesn't turn up as mentions.";
/** The page as the build before padppl rendered it. */
function before(page) {
  return String(page).replace(/[ \t]*<p id="blocking">[\s\S]*?<\/p>\r?\n/, "").split(NEW_MENTION).join(OLD_MENTION);
}
module.exports = { before, NEW_MENTION, OLD_MENTION };
