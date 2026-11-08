// casino/themes.js — the card tables' themes (hand-off 20; owner 2026-11-04, NL-5: "poker table themes (western saloon)").
//
// A theme is PRESENTATION ONLY: the felt, the rail, the frame and the scene behind the table, card backs, chip faces, optional
// sound cues and a little of the dealer's talk. Never the rules, the deck, the fairness proof, the timers or a PAT amount.
//   * per table, chosen when it opens (!holdem start 25/50 saloon - the word in any position after start - or the lobby's
//     picker); a table keeps it for its whole life (T.theme, saved with the table; an old table without one = classic);
//   * the switch casino_themes (casino_settings): "off" (the default: no picker, a theme word is ignored with a note, every
//     table SHOWS as classic - even one opened while it was on), "staff" (only a casino admin picks; everyone sees a
//     staff-opened saloon table as saloon), "everyone";
//   * free for now: `unlock` is reserved for a later PAT price / Season Pass item (Question 1);
//   * the dealer's flavour lines (locales/en.json keys in `lines`) at two moments only: when the table opens, and on a
//     showdown pot of BIG_POT_BB big blinds or more (casino/holdem.js) - at most one extra line per hand, never on classic;
//     a per-table counter (T.flav, seeded from the table id) rotates the variants;
//   * the look: public/css/casino-themes.css (scoped under .cz-theme-<id> on the table wrap) + the art in
//     views/partials/casino-theme-<id>.ejs, loaded by the table page only when the table has a theme; the sound cues
//     (`sound`, cue names) in public/js/casino-sound.js, opt-in per viewer.
// Pure: no database, no clock. test/casino-themes.test.js.
"use strict";
let EN = null;
const en = () => { if (!EN) { try { EN = require("../locales/en.json"); } catch (e) { EN = {}; } } return EN; };

const THEMES = Object.freeze({
  classic: Object.freeze({ id: "classic", name: "js.casino.theme_classic", games: ["holdem", "bj"], unlock: null, default: true,
                           lines: {}, sound: [] }),
  saloon: Object.freeze({ id: "saloon", name: "js.casino.theme_saloon", games: ["holdem"], unlock: null,
                          lines: { open: ["casino.theme_saloon_open1", "casino.theme_saloon_open2", "casino.theme_saloon_open3", "casino.theme_saloon_open4"],
                                   pot: ["casino.theme_saloon_pot1", "casino.theme_saloon_pot2", "casino.theme_saloon_pot3", "casino.theme_saloon_pot4"] },
                          sound: ["chip", "card", "bell"] }),
});
const DEFAULT = "classic";
const MODES = ["off", "staff", "everyone"];
const BIG_POT_BB = 50;                // a showdown pot this many big blinds or more gets the dealer's line (decision 6)
const NOTE_OFF = "themes aren't on yet - opening a classic table.";
const NOTE_STAFF = "table themes are staff-only for now - opening a classic table.";
const has = (id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(THEMES, id);

/** a word typed after start -> a theme id, or null */
function parseThemeWord(word) {
  const w = String(word == null ? "" : word).trim().toLowerCase();
  return has(w) ? w : null;
}
/** the switch: "off" | "staff" | "everyone" (anything else = off) */
const mode = (settings) => (settings && MODES.includes(settings.casino_themes) ? settings.casino_themes : "off");
/** theme `id` is drawn for `game` ("holdem" | "bj") */
const offers = (id, game) => has(id) && THEMES[id].games.includes(game);
/** may this viewer pick a theme? viewer = {admin: the casino admin capability} or null (signed out) */
function allowed(viewer, settings) {
  const m = mode(settings);
  if (!viewer) return false;
  return m === "everyone" || (m === "staff" && !!viewer.admin);
}
const gameOf = (T) => (T && T.game === "holdem" ? "holdem" : "bj");
/** the theme a table SHOWS: its own, or classic whenever the switch is off / the id is unknown */
function themeOf(T, settings) {
  if (mode(settings) === "off" || !T) return DEFAULT;
  return offers(T.theme, gameOf(T)) ? T.theme : DEFAULT;
}
/** a theme to store on a new table: a known one for this game, else classic */
const clean = (id, game) => (offers(id, game) ? id : DEFAULT);

/** A start command's words -> {theme, rest, unknown}: `theme` the first theme word, `rest` every other word in order (the
 *  game reads its blinds / hr from it), `unknown` the first word that is neither a theme nor a stake word (stake(word)). */
function pick(words, stake) {
  const out = { theme: null, rest: [], unknown: null };
  for (const raw of Array.isArray(words) ? words : []) {
    const w = String(raw == null ? "" : raw).trim();
    if (!w) continue;
    const id = parseThemeWord(w);
    if (id) { if (!out.theme) out.theme = id; continue; }
    if (!stake(w) && !out.unknown) out.unknown = w;
    out.rest.push(w);
  }
  return out;
}
/** The theme a start gets: p = pick(...), m = mode, admin = the opener has the casino admin capability (asked only for staff)
 *  -> {theme, note?, refuse?}. Off: theme words dropped with a note, everything else as before themes existed. */
function decide(p, m, admin, game) {
  if (m === "off") return { theme: DEFAULT, note: p.theme && p.theme !== DEFAULT ? NOTE_OFF : null };
  if (p.unknown) {
    const list = Object.keys(THEMES).filter((id) => offers(id, game)).join(", ");
    return { refuse: `there's no table theme called "${String(p.unknown).slice(0, 24)}" - themes: ${list}.` };
  }
  if (!p.theme || p.theme === DEFAULT) return { theme: DEFAULT, note: null };
  if (!offers(p.theme, game)) return { theme: DEFAULT, note: `the ${p.theme} theme isn't on ${game === "bj" ? "blackjack" : "Hold'em"} tables yet - opening a classic table.` };
  if (m === "staff" && !admin) return { theme: DEFAULT, note: NOTE_STAFF };
  return { theme: p.theme, note: null };
}

/** what the lobby tells a viewer: may they pick, and the themes (id + the games each is drawn for) */
function lobbyInfo(viewer, settings) {
  const pick = allowed(viewer, settings);
  return { pick, list: pick ? Object.values(THEMES).map((t) => ({ id: t.id, games: t.games.slice(), default: !!t.default })) : [] };
}

/** The dealer's flavour line for `event` at table T (its next variant; T.flav keeps the per-table counter), or null:
 *  classic, the switch off, or no line for that event. vars fill {name} / {sb} / {bb} / {pot} (raw text - a chat line). */
function line(T, settings, event, vars) {
  const id = themeOf(T, settings);
  const keys = THEMES[id].lines[event];
  if (!keys || !keys.length) return null;
  T.flav = T.flav && typeof T.flav === "object" ? T.flav : {};
  if (!Number.isInteger(T.flav[event])) T.flav[event] = parseInt(String(T.id || "").slice(-6), 16) || 0;
  const n = T.flav[event];
  T.flav[event] = (n + 1) % 1e6;
  const tpl = String(en()[keys[n % keys.length]] || "");
  if (!tpl) return null;
  const raw = tpl.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return raw.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}

module.exports = { THEMES, DEFAULT, MODES, BIG_POT_BB, NOTE_OFF, NOTE_STAFF, parseThemeWord, mode, offers, allowed, themeOf, clean, pick,
                   decide, lobbyInfo, line };
