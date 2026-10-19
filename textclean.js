// textclean.js (1.99ade) - invisible characters out of text that a model reads.
//
// Free text people type (a bounty's task and claim notes, a market question, a dispute reason, a feed post) and third-party
// text the site fetches (a link preview's title / description) reaches Pepe's LLMs: his bounty evidence check (which can
// award a bounty on its own), his AI market judge, his feed replies. Characters that are invisible on the page are not
// invisible to a model, and some can carry a whole hidden instruction. They are dropped where such text comes in:
//   * Unicode "format" characters (\p{Cf}): zero-width spaces / joiners, bidi controls, the BOM, the soft hyphen;
//   * the whole TAG block U+E0000-E007F (assigned or not), which spells out hidden ASCII ("ASCII smuggling");
//   * variation selectors (U+FE00-FE0F, U+E0100-E01EF), which can encode any bytes behind one visible character ("emoji
//     smuggling") - except ONE text / emoji presentation selector (U+FE0E / U+FE0F) right after a visible character, which
//     is how ordinary emoji are written (a red heart, a keycap digit);
//   * other invisible marks: the combining grapheme joiner U+034F, the Mongolian free variation selectors U+180B-180F, the
//     Khmer inherent vowels U+17B4/17B5.
// Blank "letters" (the Hangul fillers U+115F, U+1160, U+3164, U+FFA0 and the blank braille cell U+2800) and the line /
// paragraph separators (U+2028, U+2029, NEL U+0085, VT, FF) become a plain space: a reader sees a gap there, and a model
// must not see a new line where a fake "SYSTEM:" line could start. oneLine() also folds every other run of whitespace,
// new lines included, into one space for the one-line fields (claim notes, reasons).
// One exception to the format rule: a zero-width joiner BETWEEN two emoji (a family, a profession emoji) stays, so emoji
// sequences don't fall apart; the tag characters of a subdivision flag do go (the flag shows as a plain black flag).
// Look-alike letters (Cyrillic, fullwidth, math alphabets) are visible text and are left alone - a model reads them as
// the words they look like, so they hide nothing from it; the page labels member text as the member's own words instead.
// The prompt side - fencing the text as data - is Pepe's (the prompts live in the bot).
"use strict";

// everything this file touches, for the quick "nothing to do" test
const ANY = /[\p{Cf}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFFA0\u2028\u2029\u0085\u000B\u000C]/u;
const VS_RUN = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+/gu;
const DROP = /[\u{E0000}-\u{E007F}\u034F\u17B4\u17B5\u180B-\u180F]/gu;
const BLANK = /[\u115F\u1160\u3164\uFFA0\u2800\u2028\u2029\u0085\u000B\u000C]/g;
const CF = /\p{Cf}/gu;
const PIC_BEFORE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]$/u;
const PIC_AFTER = /^\p{Extended_Pictographic}/u;
const VISIBLE_BEFORE = /[^\s\p{Cf}\p{Mn}\p{Me}]$/u;

/** s without invisible characters (see the top of the file). Never throws; null/undefined -> "". */
function stripFormat(s) {
  let str = String(s == null ? "" : s);
  if (!ANY.test(str)) return str;
  str = str.replace(DROP, "").replace(BLANK, " ");
  // variation selectors: one U+FE0E / U+FE0F right after a visible character stays; any other one, and every run, goes
  str = str.replace(VS_RUN, (run, i, all) => (run.length === 1 && (run === "\uFE0E" || run === "\uFE0F")
                                               && VISIBLE_BEFORE.test(all.slice(Math.max(0, i - 2), i)) ? run : ""));
  return str.replace(CF, (c, i, all) => (c === "\u200D" && PIC_BEFORE.test(all.slice(Math.max(0, i - 2), i))
                                         && PIC_AFTER.test(all.slice(i + 1, i + 3)) ? c : ""));
}

/** A one-line field (a claim note, a reason): stripFormat, then every run of whitespace (new lines too) is one space. */
function oneLine(s, max) {
  const out = stripFormat(s).replace(/\s+/g, " ").trim();
  return max ? out.slice(0, max).trim() : out;
}

module.exports = { stripFormat, oneLine };
