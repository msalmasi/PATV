// cosmeticstyle.js — S1 Q5a (ADR 0007 D13, release L2): the account cosmetics' STRUCTURED style fields, the CSS v1 draws
// from them, and the structured look the chat hub gets (the looks/changed topic and POST /internal/v1/looks, Q5b).
// Pure functions: no database, no require of the site's modules, so a test (or the hub repo) can load it alone.
//
// Until 1.99ads the ring, border and banner items of cosmetics.json carried hand-written CSS strings. They now carry fields,
// and this module writes the same CSS from them, character for character (test/cosmetics-structured.test.js compares every
// item's render() with test/fixtures/cosmetics-css-golden.json, taken from the catalog before the change):
//
//   avatar_decoration  style.ring  = {border: Color, shadows: [Shadow]}       -> "border-color: …; box-shadow: …;"
//                      style.conic = [stop, …] (CSS colour stops; unchanged)  -> "background: conic-gradient(…);"
//                      style.spin, style.emoji                                (unchanged)
//   profile_border     style.border = {w, line: solid|double, color: Color, image?: {grad: Gradient, slice},
//                                      outline?: {w, line, color, offset}, shadows?: [Shadow]}
//                                                                             -> "border: …; [border-image: …;] [outline: …;
//                                                                                outline-offset: …;] [box-shadow: …;]"
//                      style.animated, style.hue                              (unchanged: the frame's pulse / hue class)
//   profile_banner     style.banner = [Gradient, …] (CSS layers, top first)   -> the background value
//   name_color, profile_effect, gtf_*: unchanged ({color} | {gradient, animate}; {effect}; {layer})
//
//   Color    "#rgb" | "#rrggbb" | "transparent" | {hex: "#rrggbb", a: 0..1}    ({hex, a} is written rgba(r, g, b, .a))
//   Shadow   {inset?: true, y?: px, blur?: px, spread?: px, color: Color}   -> "[inset ]0 <y> <blur>[ <spread>] <color>"
//   Gradient {fn: linear | repeating-linear | radial | repeating-radial, angle (linear, deg) | shape + at: [x%, y%] (radial),
//             stops: [Color | [Color, "<positions>"]]}
//
// The hub never gets CSS (CA §5.5: render hints only). lookOf(item) is the item's part of a structured look (rt-schema
// look.schema.json): name {kind, colors ≤ 12, anim, period_s}, avatar.deco {ring {colors ≤ 8, w ≤ 8, glow, spin}, emoji},
// profile.border {colors ≤ 8, w ≤ 8, anim: none|pulse|hue}, profile.banner {colors ≤ 8, angle}, profile.effect (EFFECTS)
// and the six gtf layers (GTF_LAYERS). Colours are 6-digit lower-case hex. Every catalog item fits whole (the longest:
// nc_parade's 9 stops, the pride ring / border / banner's 6); a list longer than the schema allows would be down-sampled
// evenly (first and last kept) - a guard only: the test refuses it for any catalog item.
"use strict";

const EFFECTS = ["sparkle", "snow", "embers", "confetti", "matrix", "hearts", "disco", "pridefetti"];
const GTF_OPT = { gtf_hat: "hat", gtf_mask: "mask", gtf_outfit: "outfit", gtf_prop: "prop", gtf_bg: "bg", gtf_frame: "frame" };
const GTF_LAYERS = {
  gtf_hat: ["crown", "tophat", "cowboy", "beanie", "halo", "horns", "party", "chef", "viking", "pirate",
            "beehive", "tiara", "rainbowwig", "muir", "bow", "catears", "bunny", "flowercrown", "bountyhat", "lotus"],
  gtf_mask: ["balaclava", "domino", "sunglasses", "monocle", "eyepatch", "bandana", "lashes", "puphood", "heartshades", "alien"],
  gtf_outfit: ["suit", "hoodie", "prison", "tuxedo", "goldchain", "bandolier",
               "sequin", "boa", "harness", "collar", "latex", "sundress", "cardigan", "pridecape", "reaper"],
  gtf_prop: ["cigar", "moneybag", "crowbar", "briefcase", "rose", "dice",
             "prideflag", "discoball", "flamingo", "fan", "cuffs", "crop", "boba", "strawberry", "plushie", "sheriffstar", "scythe", "skateboard"],
  gtf_bg: ["vault", "neon", "city", "jail", "sunset", "matrix",
           "progress", "intersex", "trans", "bi", "lesbian", "pan", "enby", "ace", "aro", "genderfluid",
           "lavalamp", "leopard", "redroom", "sakura", "clouds", "wanted", "lilypond"],
  gtf_frame: ["gold", "diamond", "flame", "neon", "pixel", "glitter", "rainbow", "chain", "hearts", "rope", "laurel"],
};
const NAME_PERIOD_S = 6;                 // cosmetics.css cx-shift: 6s
const CONIC_RING_W = 6;                  // .cx-av .cx-conic: the mask leaves a 6px ring
// rt-schema look.schema.json's caps (raised by the S1 Q5b review to chat-core's render bounds, so every catalog item travels
// whole - ADR 0007 D13; test/cosmetics-structured.test.js checks no item is cut, and the hub's schema with PATV_HUB_DIR)
const MAX = { name: 12, ring: 8, border: 8, banner: 8, w: 8 };

// ── CSS from the fields ──
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const num = (n) => {
  const s = String(Number(n));
  return s.startsWith("0.") ? s.slice(1) : s;           // 0.35 -> ".35" (v1's hand-written style)
};
function rgb(hex) {
  const h = hex6(hex);
  if (!h) throw new Error("cosmeticstyle: bad hex " + hex);
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function color(c) {
  if (typeof c === "string") {
    if (c === "transparent" || HEX_RE.test(c)) return c;
    throw new Error("cosmeticstyle: bad colour " + c);
  }
  if (c && typeof c === "object" && typeof c.hex === "string") {
    const a = Number(c.a);
    if (!(a >= 0 && a <= 1)) throw new Error("cosmeticstyle: bad alpha " + c.a);
    return `rgba(${rgb(c.hex).join(", ")}, ${num(a)})`;
  }
  throw new Error("cosmeticstyle: bad colour");
}
const px = (n) => (Number(n) ? `${num(n)}px` : "0");
function shadow(s) {
  return `${s.inset ? "inset " : ""}0 ${px(s.y || 0)} ${px(s.blur || 0)}${s.spread != null ? " " + px(s.spread) : ""} ${color(s.color)}`;
}
const stop = (s) => (Array.isArray(s) ? `${color(s[0])} ${s[1]}` : color(s));
function gradient(g) {
  const radial = /radial$/.test(g.fn);
  const head = radial ? `${g.shape} at ${num(g.at[0])}% ${num(g.at[1])}%` : `${num(g.angle)}deg`;
  return `${g.fn}-gradient(${[head].concat(g.stops.map(stop)).join(", ")})`;
}
/** avatar_decoration style.ring -> the ring CSS (border colour + box shadows). */
function ringCss(ring) {
  if (!ring) return "";
  const sh = (ring.shadows || []).map(shadow);
  return `border-color: ${color(ring.border)};` + (sh.length ? ` box-shadow: ${sh.join(", ")};` : "");
}
/** avatar_decoration style.conic -> the conic ring CSS (stops are CSS colour stops, as v1 always had them). */
const conicCss = (stops) => (Array.isArray(stops) && stops.length ? `background: conic-gradient(${stops.join(", ")});` : "");
/** profile_border style.border -> the frame CSS. */
function borderCss(b) {
  if (!b) return "";
  let css = `border: ${px(b.w)} ${b.line || "solid"} ${color(b.color)};`;
  if (b.image) css += ` border-image: ${gradient(b.image.grad)} ${num(b.image.slice)};`;
  if (b.outline) css += ` outline: ${px(b.outline.w)} ${b.outline.line} ${color(b.outline.color)}; outline-offset: ${px(b.outline.offset)};`;
  if (b.shadows && b.shadows.length) css += ` box-shadow: ${b.shadows.map(shadow).join(", ")};`;
  return css;
}
/** profile_banner style.banner -> the background value (layers, top first). */
const bannerCss = (layers) => (Array.isArray(layers) ? layers.map(gradient).join(", ") : "");

// ── the structured look (rt-schema look.schema.json) ──
/** "#abc" / "#AABBCC" -> "#aabbcc"; anything else null. */
function hex6(c) {
  const s = String(c == null ? "" : c).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return "#" + s.slice(1).split("").map((x) => x + x).join("");
  return null;
}
/** A Color / stop / CSS stop string -> its 6-digit hex, or null (transparent, a direction like "from -45deg"). */
function hexOf(c) {
  if (Array.isArray(c)) return hexOf(c[0]);
  if (c && typeof c === "object") return hex6(c.hex);
  const first = String(c == null ? "" : c).trim().split(/\s+/)[0];
  return hex6(first);
}
const uniq = (list) => list.filter((x, i) => x && list.indexOf(x) === i);
/** At most k entries, evenly spaced, the first and last kept. */
function downsample(list, k) {
  if (list.length <= k) return list.slice();
  const out = [];
  for (let i = 0; i < k; i++) out.push(list[Math.round((i * (list.length - 1)) / (k - 1))]);
  return out;
}
const clampW = (w) => Math.max(0, Math.min(MAX.w, Math.round(Number(w) || 0)));

function lookName(item) {
  const s = (item && item.style) || {};
  if (Array.isArray(s.gradient) && s.gradient.length) {
    const colors = downsample(s.gradient.map(hex6).filter(Boolean), MAX.name);
    if (colors.length) {
      const n = { item: item.id, kind: "gradient", colors, anim: s.animate ? "shift" : "none" };
      if (s.animate) n.period_s = NAME_PERIOD_S;
      return n;
    }
  }
  const c = hex6(s.color);
  return c ? { item: item.id, kind: "solid", colors: [c] } : null;
}
function lookRing(item) {
  const s = (item && item.style) || {};
  let ring;
  if (s.ring) {
    const sh = s.ring.shadows || [];
    const spread = sh.find((x) => x.spread != null);
    const glow = sh.find((x) => x.spread == null && Number(x.blur) > 0);
    const colors = uniq([hexOf(s.ring.border)].concat(sh.map((x) => hexOf(x.color))));
    ring = { colors: downsample(colors, MAX.ring), w: clampW(spread ? spread.spread : 0),
             glow: glow && glow.color && typeof glow.color === "object" ? Number(glow.color.a) : 0, spin: s.spin === true };
  } else if (Array.isArray(s.conic) && s.conic.length) {
    ring = { colors: downsample(uniq(s.conic.map(hexOf)), MAX.ring), w: CONIC_RING_W, glow: 0, spin: s.spin === true };
  }
  if (ring && !ring.colors.length) ring = null;
  const deco = { item: item.id };
  if (ring) deco.ring = ring;
  if (s.emoji) deco.emoji = String(s.emoji);
  return deco;
}
function lookBorder(item) {
  const s = (item && item.style) || {};
  const b = s.border;
  if (!b) return null;
  let colors = hexOf(b.color) ? [hexOf(b.color)] : b.image ? b.image.grad.stops.map(hexOf) : [];
  if (b.outline) colors = colors.concat(hexOf(b.outline.color));
  colors = downsample(uniq(colors), MAX.border);
  if (!colors.length) return null;
  return { colors, w: clampW(b.w), anim: s.hue ? "hue" : s.animated ? "pulse" : "none" };
}
function lookBanner(item) {
  const s = (item && item.style) || {};
  const layers = Array.isArray(s.banner) ? s.banner : [];
  if (!layers.length) return null;
  const base = layers[layers.length - 1];                // the bottom layer: what the banner "is"
  let colors = uniq(base.stops.map(hexOf));
  if (!colors.length) colors = uniq([].concat(...layers.map((g) => g.stops.map(hexOf))));
  if (!colors.length) return null;
  const angle = /radial$/.test(base.fn) ? 180 : ((Math.round(Number(base.angle) || 0) % 360) + 360) % 360;
  return { colors: downsample(colors, MAX.banner), angle };
}
const lookEffect = (item) => {
  const e = item && item.style && item.style.effect;
  return EFFECTS.includes(e) ? e : null;
};
const lookGtf = (item) => {
  const l = item && item.style && item.style.layer;
  return item && GTF_LAYERS[item.kind] && GTF_LAYERS[item.kind].includes(l) ? l : null;
};
/** The item's part of a structured look: {name} | {deco} | {border} | {banner} | {effect} | {gtf: [opt, layer]} | null. */
function lookOf(item) {
  if (!item) return null;
  switch (item.kind) {
    case "name_color": { const n = lookName(item); return n ? { name: n } : null; }
    case "avatar_decoration": return { deco: lookRing(item) };
    case "profile_border": { const b = lookBorder(item); return b ? { border: b } : null; }
    case "profile_banner": { const b = lookBanner(item); return b ? { banner: b } : null; }
    case "profile_effect": { const e = lookEffect(item); return e ? { effect: e } : null; }
    default: {
      const l = lookGtf(item);
      return l ? { gtf: [GTF_OPT[item.kind], l] } : null;
    }
  }
}

module.exports = { ringCss, conicCss, borderCss, bannerCss, gradient, shadow, color, lookOf, lookName, lookRing, lookBorder, lookBanner,
                   lookEffect, lookGtf, hex6, hexOf, downsample, EFFECTS, GTF_OPT, GTF_LAYERS, NAME_PERIOD_S, CONIC_RING_W, MAX };
