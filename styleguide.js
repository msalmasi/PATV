// styleguide.js - 1.99pj: /styleguide, the living styleguide of the PATV design system (public/css/ds.css,
// spec in docs/design-system.md). Unlisted (no menu link, noindex) but public, so anyone polishing a page can open it
// without an admin session. It renders every token and ds-* component straight from ds.css - nothing on it is
// page-specific, so a change to ds.css shows up here first. English only: it's a developer reference, like /admin.
"use strict";

// The token tables the page renders (names only - the values are read from ds.css in the browser, so the page can't
// drift from the stylesheet). Grouped as in docs/design-system.md section 2.
const TOKENS = {
  surfaces: ["--ds-bg", "--ds-sunken", "--ds-surface", "--ds-surface-2", "--ds-surface-3", "--ds-hover"],
  lines: ["--ds-line-soft", "--ds-line", "--ds-line-strong", "--ds-line-menu"],
  text: ["--ds-text-strong", "--ds-text", "--ds-text-2", "--ds-text-muted", "--ds-text-faint", "--ds-text-disabled"],
  brand: ["--ds-green", "--ds-green-2", "--ds-green-line", "--ds-green-deep", "--ds-brand", "--ds-on-ac"],
  gold: ["--ds-gold", "--ds-gold-2", "--ds-gold-text", "--ds-gold-line", "--ds-on-gold"],
  semantic: ["--ds-ok", "--ds-warn", "--ds-warn-fill", "--ds-danger", "--ds-danger-solid", "--ds-danger-fill", "--ds-info", "--ds-info-fill", "--ds-live", "--ds-live-2", "--ds-badge"],
  areas: ["--ds-acc-markets", "--ds-acc-wagers", "--ds-acc-polls", "--ds-acc-bounties", "--ds-acc-lotto", "--ds-acc-casino", "--ds-acc-gtf",
          "--ds-acc-gtf-violet", "--ds-acc-support", "--ds-acc-plex", "--ds-acc-premium", "--ds-acc-ach"],
  rarity: ["--ds-r-common", "--ds-r-uncommon", "--ds-r-rare", "--ds-r-epic", "--ds-r-legendary"],
  platforms: ["--ds-twitch", "--ds-discord", "--ds-camfrog", "--ds-plex"],
};
const TYPE = [
  // [role, class, token size, line-height, weight, tracking, sample]
  ["Display (hero h1)", "ds-display", "--ds-fs-display", "1.1", "700", "-0.01em", "Prediction Markets"],
  ["H1 (page title, no hero)", "ds-h1", "--ds-fs-h1", "1.15", "700", "-0.005em", "Your orders"],
  ["H2 (section)", "ds-h2 dot", "--ds-fs-h2", "1.25", "700", "0", "Open markets"],
  ["Pixel heading (section, arcade)", "ds-pixel-h", "--ds-fs-pixel-h", "1.6", "400", "0.04em", "Vault stashes"],
  ["H3 (card title)", "ds-h3", "--ds-fs-h3", "1.3", "700", "0", "Will Pepe hit 10k viewers?"],
  ["H4 (sub-heading)", "ds-h4", "--ds-fs-h4", "1.35", "700", "0", "How payouts work"],
  ["Eyebrow", "ds-eyebrow", "--ds-fs-eyebrow", "1.7", "400", "0.12em", "PATV · Play"],
  ["Lead", "ds-lead", "--ds-fs-lead", "1.55", "400", "0", "Bet PAT on what happens next in the rooms. Prices move with every trade."],
  ["Body", "ds-body", "--ds-fs-body", "1.55", "400", "0", "Body copy is 15px on every screen size, 1.55 line-height, #e6e6e6."],
  ["Small", "ds-sub", "--ds-fs-sm", "1.5", "400", "0", "Secondary copy and descriptions under headings."],
  ["Meta", "ds-meta", "--ds-fs-meta", "1.5", "400", "0", "by sard0nicgrin · 3 h ago · 12 replies"],
  ["Fine print", "ds-fine", "--ds-fs-xs", "1.45", "400", "0", "Fees: 2% of winnings go to the jackpot."],
  ["Label", "ds-label", "--ds-fs-label", "1.3", "700", "0.06em", "Stake (PAT)"],
  ["Mono", "ds-mono", "--ds-fs-mono", "1.4", "400", "0", "M-1042 · 0x3f…a91c"],
];
const SPACE = ["--ds-sp-px", "--ds-sp-1", "--ds-sp-1h", "--ds-sp-2", "--ds-sp-2h", "--ds-sp-3", "--ds-sp-3h", "--ds-sp-4", "--ds-sp-5", "--ds-sp-6", "--ds-sp-7", "--ds-sp-8", "--ds-sp-10", "--ds-sp-12", "--ds-sp-14"];
const RADII = ["--ds-r-xs", "--ds-r-sm", "--ds-r-md", "--ds-r-lg", "--ds-r-xl", "--ds-r-2xl", "--ds-r-pill"];
const ELEV = ["--ds-e-1", "--ds-e-2", "--ds-e-3", "--ds-e-4"];

// 1.99qa: /styleguide is a hub - Brand, Design system, Pepe and Writing - so the brand guide (docs/brand.md) and the
// design system live in one place. The Brand / Pepe / Writing tabs render docs/brand.md server-side with mdlite.js
// (escapes everything, no raw HTML), split by its numbered "## N." sections. The token page moved to /styleguide/design;
// old /styleguide#colour-style links are forwarded there by a tiny script on the hub home.
const fs = require("fs");
const path = require("path");
const md = require("./mdlite");

const BRAND_MD = path.join(__dirname, "docs", "brand.md");
const LOOKS_DIR = path.join(__dirname, "public", "img", "pepe-looks");
// which numbered sections of brand.md each tab shows (0 = the intro before the first "## ")
const TAB_SECTIONS = { brand: [0, 1, 2, 3, 4], pepe: [5], writing: [6] };
const TABS = ["home", "brand", "design", "pepe", "writing"];

let cache = { mtime: 0, parts: null };
function brandParts() {
  let st;
  try { st = fs.statSync(BRAND_MD); } catch (_) { return []; }
  if (cache.parts && cache.mtime === st.mtimeMs) return cache.parts;
  cache = { mtime: st.mtimeMs, parts: md.sections(fs.readFileSync(BRAND_MD, "utf8")) };
  return cache.parts;
}

/** The rendered HTML + table of contents for one hub tab (brand / pepe / writing). */
function brandTab(tab) {
  const want = TAB_SECTIONS[tab] || [];
  const src = brandParts().filter((p) => want.includes(p.n)).map((p) => p.md).join("\n\n")
    .replace(/^# .*$/m, ""); // the doc's own "# title" - the hub hero is the page's one h1
  return md.render(src);
}

// Pepe's looks (public/img/pepe-looks/*.png): base art, costume looks (klook-*), holiday looks and mods (mod-*).
function pepeLooks() {
  let files = [];
  try { files = fs.readdirSync(LOOKS_DIR).filter((f) => /\.png$/.test(f)); } catch (_) {}
  const nice = (id) => id.replace(/^(klook|mod|base)-/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ")
    .replace(/(^|\s)\w/g, (c) => c.toUpperCase());
  const group = (id) => (id.startsWith("base-") || id === "pepe" ? "base" : id.startsWith("klook-") ? "persona" : id.startsWith("mod-") ? "mod" : "costume");
  return files.sort().map((f) => { const id = f.replace(/\.png$/, ""); return { id, file: f, name: nice(id), group: group(id) }; });
}

function register(app, { addUser }) {
  const user = (req) => (req.user ? req.user.username : null);
  app.get("/styleguide", addUser, (req, res) => {
    res.set("X-Robots-Tag", "noindex");
    res.render("styleguide-hub", { title: "Styleguide · PATV", user: user(req), tab: "home", doc: null, looks: [] });
  });
  app.get("/styleguide/design", addUser, (req, res) => {
    res.set("X-Robots-Tag", "noindex");
    res.render("styleguide", { title: "Design system · PATV", user: user(req), TOKENS, TYPE, SPACE, RADII, ELEV });
  });
  for (const tab of ["brand", "pepe", "writing"]) {
    app.get("/styleguide/" + tab, addUser, (req, res) => {
      res.set("X-Robots-Tag", "noindex");
      const titles = { brand: "Brand", pepe: "Pepe", writing: "Writing" };
      res.render("styleguide-hub", { title: titles[tab] + " · Styleguide · PATV", user: user(req), tab, doc: brandTab(tab), looks: tab === "pepe" ? pepeLooks() : [] });
    });
  }
}

module.exports = { register, TOKENS, TYPE, SPACE, RADII, ELEV, TABS, TAB_SECTIONS, brandTab, pepeLooks };
