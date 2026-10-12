// usernamerules.js — 1.99ui: the ONE username length limit, and the patterns built from it.
//
// A PATV username is letters, digits, dot, dash and underscore. USERNAME_MAX is both:
//   * the longest name the site RECOGNISES in text and URLs (@mentions + the mention dropdown, u/<name> refs, profile
//     scopes) - so a long legacy name (prod's longest is 46 characters) still mentions, notifies and links; and
//   * the longest name anyone can CHOOSE or be given from now on (sign-up, Edit profile rename, Pepe's !patv set,
//     Plex / Telegram / Google / Twitch / Discord accounts, Pepe's automatic "CF..." Camfrog accounts).
// Existing longer names (none on prod) are left alone - they just aren't matched in text.
//
// Client-side copies (they can't require this file) carry the same number and are checked by test/username-limit.test.js:
// views/register.ejs, views/plexSso.ejs, views/ssoNew.ejs, views/editProfile.ejs (maxlength), views/partials/auth-js.ejs,
// public/js/mention-complete.js.
"use strict";

const USERNAME_MIN = 3;
const USERNAME_MAX = 48;

// a username inside text (@name, u/name): starts and ends with a letter / digit (so trailing punctuation isn't eaten)
const NAME_SRC = "[A-Za-z0-9](?:[A-Za-z0-9._-]{0," + (USERNAME_MAX - 2) + "}[A-Za-z0-9])?";
// a username in a URL or scope key (u/<name>, profile:<name>): the charset, 1..USERNAME_MAX
const NAME_CHARS_SRC = "[A-Za-z0-9._\\-]{1," + USERNAME_MAX + "}";
// a NEW username's charset + length (authGuard.checkUsername adds the "no dot / dash / underscore at the ends" and
// reserved "CF" rules)
const NEW_USERNAME_RE = new RegExp("^[A-Za-z0-9_.-]{" + USERNAME_MIN + "," + USERNAME_MAX + "}$");

module.exports = { USERNAME_MIN, USERNAME_MAX, NAME_SRC, NAME_CHARS_SRC, NEW_USERNAME_RE };
