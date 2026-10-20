// textstyle.js — S1 Q5b (ADR 0007 D13, CA §5.5 "Text style"): a member's chat text style, users.text_style - the colour
// and face of their message body in the native chat. v1 owns it until looks move (P-4): it reaches the chat hub in the
// looks (looks/changed, POST /internal/v1/looks) as text {color, font, scope: "all"}; the hub validates it again on apply
// (contrast on both themes, distance from the reserved accents) and derives the theme pair. The picker on Edit profile is
// S1 V3 (release L5); until then only set() (and the contract driver) writes it.
//
//   users.text_style   NULL (no style) | JSON {"color": "#rrggbb" | null, "font": "sans|serif|mono|rounded|comic|pixel"}
//
// The palette and the fonts are chat-text-styles.json: rt-schema's registry/text-styles.json byte for byte (its sha256 is
// pinned in test/huboutbox-s1.test.js; a palette change is an rt-schema PR first, then this copy). A colour must be one of
// the palette's values (either theme's); no text_style cosmetic item exists yet to unlock another (CA §5.5). A stored value
// that fails (an old palette, a hand edit) is no style: parse() answers null and the look leaves text out.
"use strict";
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery, tx } = require("./dbUtils");

const REG = JSON.parse(fs.readFileSync(path.join(__dirname, "chat-text-styles.json"), "utf8"));
const FONTS = Object.keys(REG.fonts || {});
const PALETTE = new Map();          // hex -> palette key (both themes' values)
for (const [k, v] of Object.entries(REG.palette || {})) for (const t of ["dark", "light"]) if (v && v[t]) PALETTE.set(String(v[t]).toLowerCase(), k);
const HEX_RE = /^#[0-9a-f]{6}$/;

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      try { await runQuery("ALTER TABLE users ADD COLUMN text_style TEXT"); }
      catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** {color?, font?} (or a stored JSON string) -> the clean style {color: hex | null, font} or null (none / invalid). */
function clean(v) {
  let o = v;
  if (o == null || o === "") return null;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch (e) { return null; } }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const color = o.color == null || o.color === "" ? null : String(o.color).trim().toLowerCase();
  if (color !== null && (!HEX_RE.test(color) || !PALETTE.has(color))) return null;
  const font = o.font == null || o.font === "" ? "sans" : String(o.font);
  if (!FONTS.includes(font)) return null;
  if (color === null && font === "sans") return null;            // nothing set: the default
  return { color, font };
}
const parse = (raw) => clean(raw);
/** The look's text field for a stored value, or null: {color?, font, scope: "all"} (styles set on PATV are always "all"). */
function lookText(raw) {
  const s = clean(raw);
  if (!s) return null;
  const t = {};
  if (s.color) t.color = s.color;
  t.font = s.font;
  t.scope = "all";
  return t;
}

/** Set (or clear, style null) a member's text style. Refuses an invalid one (400). -> the stored style or null */
async function set(userId, style) {
  await init();
  const s = style == null ? null : clean(style);
  if (style != null && !s) throw Object.assign(new Error("That colour or font isn't in the palette."), { status: 400, code: "bad_text_style", refuse: true });
  return tx(async () => {
    const r = await runQuery("UPDATE users SET text_style = ? WHERE userId = ?", [s ? JSON.stringify({ color: s.color, font: s.font }) : null, String(userId)]);
    if (!r || !r.changes) throw Object.assign(new Error("No such account."), { status: 404, code: "no_user", refuse: true });
    return s;
  });
}
async function get(userId) {
  await init();
  const r = (await getQuery("SELECT text_style FROM users WHERE userId = ?", [String(userId)]))[0];
  return r ? clean(r.text_style) : null;
}

module.exports = { init, clean, parse, lookText, set, get, FONTS, PALETTE, REG };
