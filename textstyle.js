// textstyle.js — S1 Q5b (ADR 0007 D13, CA §5.5 "Text style"): a member's chat text style, users.text_style - the colour
// and face of their message body in the native chat. v1 owns it until looks move (P-4): it reaches the chat hub in the
// looks (looks/changed, POST /internal/v1/looks) as text {color, font, scope: "all"}; the hub validates it again on apply
// (contrast on both themes, distance from the reserved accents) and derives the theme pair. Written by the picker on Edit
// profile (S1 V3, release L5: the "Chat text style" card, /u/<me>/edit#textstyle - its one home; the /settings hub links
// to it) through set(), and by the contract driver.
//
//   users.text_style   NULL (no style) | JSON {"color": "#rrggbb" | null, "font": "sans|serif|mono|rounded|comic|pixel"}
//
// The picker (V3) offers the palette only: it posts a palette KEY ("blue") and a font key, and stores the key's dark-theme
// value (the site's own theme); a hex, a key that isn't the palette's or an unknown font is refused. The hub turns a
// palette value of either theme into that palette pair (chat-core validateTextColor), so the preview's two themes are
// what the chat shows.
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

// ── S1 V3: the picker (Edit profile #textstyle) ──
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const SAFE_STACK = /^[A-Za-z0-9 ,"'().\-]+$/;       // a font stack the view may print into a style attribute (the registry's are)
const COLOR_KEYS = Object.keys(REG.palette || {});
const SAVES_PER_WINDOW = 30;                         // the save route's limit per member per 10 minutes (register)

/** The picker's choices, in registry order: the 16 palette colours (both themes' values) and the six fonts. */
function choices() {
  const colors = [];
  for (const key of COLOR_KEYS) {
    const p = REG.palette[key] || {};
    const dark = String(p.dark || "").toLowerCase(), light = String(p.light || "").toLowerCase();
    if (HEX_RE.test(dark) && HEX_RE.test(light)) colors.push({ key, dark, light, label_key: String(p.label_key || "textstyle.color." + key) });
  }
  const fonts = [];
  for (const key of FONTS) {
    const f = REG.fonts[key] || {};
    const scale = Number(f.size_scale) > 0 && Number(f.size_scale) <= 2 ? Number(f.size_scale) : 1;
    if (SAFE_STACK.test(String(f.stack || ""))) fonts.push({ key, stack: String(f.stack), scale, webfont: f.webfont ? String(f.webfont) : null, label_key: String(f.label_key || "textstyle.font." + key) });
  }
  // the preview's two themes: the chat's first background of each, and its link colour (mentions keep their own)
  const hex = (v, d) => (HEX_RE.test(String(v || "").toLowerCase()) ? String(v).toLowerCase() : d);
  const bg = REG.backgrounds || {}, link = (REG.reserved_accents || {}).link || {};
  const theme = {
    dark: { bg: hex((bg.dark || [])[0], "#0f0f11"), link: hex(link.dark, "#81c784") },
    light: { bg: hex((bg.light || [])[0], "#ffffff"), link: hex(link.light, "#276b2b") },
  };
  return { colors, fonts, theme };
}

/** The Google Fonts stylesheet for the fonts that need a webfont (the preview draws each face), or null. */
function webfontHref() {
  const fams = [];
  for (const key of FONTS) {
    const w = REG.fonts[key] && REG.fonts[key].webfont;
    if (w && /^[A-Za-z0-9 ]+$/.test(String(w))) fams.push("family=" + String(w).trim().replace(/ /g, "+"));
  }
  return fams.length ? "https://fonts.googleapis.com/css2?" + fams.join("&") + "&display=swap" : null;
}

/** A stored style -> what the picker shows checked: {color: palette key | null, font}. */
function pickerState(style) {
  const s = clean(style);
  return { color: s && s.color ? PALETTE.get(s.color) || null : null, font: s ? s.font : "sans" };
}

/**
 * The picker's two fields -> the style to store (null = no style). `color` is a palette key, or "" / "none" for no colour;
 * `font` a font key ("" = sans). Anything else is refused (400 bad_text_style): the palette only, never a typed hex.
 */
function fromForm(body) {
  const b = body || {};
  const bad = () => Object.assign(new Error("That colour or font isn't in the palette."), { status: 400, code: "bad_text_style", refuse: true });
  const c = typeof b.color === "string" ? b.color.trim() : b.color == null ? "" : null;
  const f = typeof b.font === "string" ? b.font.trim() : b.font == null ? "" : null;
  if (c === null || f === null) throw bad();
  let color = null;
  if (c !== "" && c !== "none") {
    if (!own(REG.palette, c) || !REG.palette[c] || !HEX_RE.test(String(REG.palette[c].dark || "").toLowerCase())) throw bad();
    color = String(REG.palette[c].dark).toLowerCase();
  }
  const font = f === "" ? "sans" : f;
  if (!own(REG.fonts, font) || !FONTS.includes(font)) throw bad();
  return color === null && font === "sans" ? null : { color, font };
}

/**
 * POST /api/u/<me>/update/textstyle {color, font} - the picker's save. A form post goes back to Edit profile #textstyle with
 * a flash; the page's script asks for JSON (Accept: application/json) and gets {ok, style: {color: key | null, font}}.
 */
function register(app, { addUser }) {
  const guard = require("./middleware/authGuard");
  // each saved change is one looks/changed row while the switch is on: 30 saves per member per 10 minutes is plenty for a picker
  const limit = guard.limiter({ max: SAVES_PER_WINDOW, windowMs: 10 * 60000 });
  app.post("/api/u/:username/update/textstyle", addUser, async (req, res) => {
    const json = /application\/json/i.test(String(req.get("accept") || ""));
    res.set("Cache-Control", "private, no-store");
    if (!req.user || !req.user.userId) return json ? res.status(401).json({ ok: false, error: "signin" }) : res.redirect("/login");
    const back = "/u/" + encodeURIComponent(req.user.username) + "/edit#textstyle";
    if (req.user.username !== req.params.username) return json ? res.status(403).json({ ok: false, error: "not_yours" }) : res.redirect(back);
    if (!guard.sameSite(req)) return json ? res.status(403).json({ ok: false, error: "cross_site" }) : res.status(403).send("Forbidden");
    const uid = String(req.user.userId);
    if (limit.blocked(uid)) {
      if (json) return res.status(429).json({ ok: false, error: "slow" });
      req.flash("error", "Too many changes - try again in a few minutes.");
      return res.redirect(back);
    }
    limit.hit(uid);
    let style;
    try { style = fromForm(req.body); }
    catch (e) {
      if (json) return res.status(400).json({ ok: false, error: e.code || "bad_text_style" });
      req.flash("error", "That colour or font isn't in the palette - nothing changed.");
      return res.redirect(back);
    }
    try {
      const saved = await set(req.user.userId, style);
      if (json) return res.json({ ok: true, style: pickerState(saved) });
      req.flash("success", saved ? "Chat text style saved." : "Chat text style reset to the default.");
    } catch (e) {
      if (!e || !e.refuse) console.error("[textstyle] save:", e && e.message);
      if (json) return res.status(e && e.refuse ? e.status || 400 : 500).json({ ok: false, error: (e && e.refuse && e.code) || "error" });
      req.flash("error", "Couldn't save your chat text style - nothing changed.");
    }
    res.redirect(back);
  });
}

module.exports = { init, clean, parse, lookText, set, get, choices, webfontHref, pickerState, fromForm, register, SAVES_PER_WINDOW, FONTS, PALETTE, REG };
