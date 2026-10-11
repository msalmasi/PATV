# PATV design system (v1, site 1.99pj)

The look of publicaccess.tv, written down so any page can be built or polished without guessing.

- **Stylesheet:** `public/css/ds.css`. It holds the tokens (`--ds-*` custom properties) and the component classes (`.ds-*`). `views/layout.ejs` loads it on every page.
- **Living styleguide:** `/styleguide` (styleguide.js, views/styleguide.ejs). It is unlisted and noindex, and renders every token and component live from ds.css. It also has an RTL toggle.
- **Origin:** the system formalises the 1.99lx–1.99pf redesigns: bets.css (markets, wagers, polls, bounties), the wallet, the shop dashboards, /economy, /premium, /support, /lotto, GTF, gangs and the casino. Wherever those pages disagreed, this document picks one value. §12 lists every disagreement and the value that won.

---

## 0. How to use it

1. **Load order.** `ds.css`, then `styles.css` (the legacy global), then the page's own CSS. Page CSS wins on ties, so a page can always override a token or component locally.
2. **Nothing is styled implicitly.** ds.css only styles elements that carry a `ds-` class. The only exceptions are a tiny base layer (font smoothing, `.sr-only`) and the header shadow alias. Old pages therefore render exactly as before until somebody migrates them.
3. **Migrating a page means:**
   - wrap it in `<main class="ds-page">` (or `.narrow` / `.read` / `.mid` / `.wide`);
   - swap the page's private copies of the hero, card, button, chip, table, form and empty state for the `ds-` classes;
   - delete the CSS that is now redundant;
   - keep only what is truly page-specific, such as the Pepeball balls, felt tables or the GTF minimap.
   - When a page keeps its own classes, it reads the tokens (`background: var(--ds-surface)`) instead of hex values.
4. **Accent.** A page sets its area accent once, on its wrapper. Every component follows it (§2.4).
5. **No new hex values** in page CSS unless they are a genuinely new illustration colour. Use a token, or add a token here and in ds.css.
6. **Strings.** New UI strings go in `locales/en.json` only. The i18n sync translates them. The styleguide itself is an English-only developer page.

---

## 1. Principles

- **Dark arcade, not neon soup.** The canvas is near-black (#0f0f11). Cards are one step lighter and separated by 1px borders, not shadows. Colour is spent on meaning: green means act or go, gold means PAT or money, red means live or danger, and each area has one accent. Press Start 2P is seasoning (eyebrows, pixel headings), never body text.
- **One thing first.** Every hero has one display headline, one lead paragraph, up to two CTAs and an optional row of stat pills. Every card has a clear title, then meta, then the action.
- **Mobile first.** Design at 375px, then let it breathe. There is never horizontal page scroll. The gutter is never under 16px. Touch targets are at least 44px.
- **Numbers are first-class.** PAT amounts are tabular, bold and gold. Units are small and muted.
- **Calm motion.** Hover is a 1px lift or a brightness bump. Entrances are a 6px fade-up. Everything turns off under `prefers-reduced-motion`.

---

## 2. Colour

All values are in ds.css `:root`. Contrast ratios below are measured against `--ds-bg` and `--ds-surface`.

### 2.1 Surfaces (darkest to lightest; one step per level of nesting)

| Token | Value | Use |
|---|---|---|
| `--ds-bg` | #0f0f11 | `body` |
| `--ds-sunken` | #0c0c0c | inputs, wells, stat tiles inside a card, `.ds-card.flat` |
| `--ds-surface` | #121212 | cards, panels, tables |
| `--ds-surface-2` | #18181b | header bar, table heads (#151515 in `.ds-tbl th`), raised tiles |
| `--ds-surface-3` | #1d1d22 | popovers, menus, modals, toasts |
| `--ds-hover` | #24242a | hover or pressed fill on quiet controls |
| `--ds-scrim` | rgba(0,0,0,.62) | behind modals and sheets |
| `--ds-glass` | rgba(0,0,0,.35) | stat pills and tiles over a hero gradient |

The hero base is `#111` under radial gradients (§6.4). It is the only other dark that may appear.

### 2.2 Lines

| Token | Value | Use |
|---|---|---|
| `--ds-line-soft` | #1d1d1d | row dividers inside cards and tables, section rules |
| `--ds-line` | #262626 | card, panel and table borders |
| `--ds-line-strong` | #333 | control borders: inputs, ghost buttons, chips |
| `--ds-line-menu` | #2c2c33 | popover, menu and modal borders (cool tint to match surface-3) |

Borders are always 1px. A 3px top accent rule (`.ds-card.top`) is the only thick border. Do not use 2px card borders.

### 2.3 Text

| Token | Value | Contrast on #121212 | Use |
|---|---|---|---|
| `--ds-text-strong` | #fff | 18.7 | headings, numbers, the first thing to read |
| `--ds-text` | #e6e6e6 | 15.0 | body copy |
| `--ds-text-2` | #cfcfcf | 12.0 | leads, secondary copy |
| `--ds-text-muted` | #9a9a9a | 6.7 | meta, captions, labels, table heads |
| `--ds-text-faint` | #8e8e8e | 5.7 | timestamps, footers. **The floor: no text lighter or darker-grey than this** (#777 and #666 fail AA) |
| `--ds-text-disabled` | #6d6d6d | 3.6 | disabled controls only (exempt) |

Legacy greys map onto these: #888, #8a8a8a, #8d8d8d and #999 become `--ds-text-muted`. #777 and #666 used for text become `--ds-text-faint`. #aaa, #bbb and #ccc become `--ds-text-2` or `--ds-text-muted` by role. #ddd and #eee become `--ds-text`.

### 2.4 Brand and accent

| Token | Value | Use |
|---|---|---|
| `--ds-green` | #4caf50 | primary action fill, accent dots, bars |
| `--ds-green-2` | #81c784 | links and accent text on dark |
| `--ds-green-bg` | rgba(76,175,80,.12) | accent tint (selected tab, focus halo) |
| `--ds-green-line` | #2e6b31 | accent-tinted borders |
| `--ds-green-deep` | #12301a | quiet filled green (navbar Post pill) |
| `--ds-brand` | #3cc47c | the `publicaccess.tv` wordmark and the current-nav underline only |
| `--ds-on-ac` | #04150a | **text on a filled accent.** Use dark ink, which is 6.8:1 on #4caf50. White on #4caf50 is 2.8:1, so never use it. |

Components read the accent through `--ds-ac`, `--ds-ac-2`, `--ds-ac-bg` and `--ds-ac-line`. A page re-points them on its wrapper:

```css
.pl { --ds-ac: var(--ds-acc-polls); --ds-ac-2: var(--ds-acc-polls-2); --ds-ac-bg: rgba(79, 195, 247, .13); --ds-ac-line: #1f5a73; --ds-on-ac: #04202c; }
```

Area accents:

| Area | `--ds-ac` | `--ds-ac-2` | Ink on fill |
|---|---|---|---|
| Markets | #4caf50 | #81c784 | #04150a |
| Wagers and pools | #e0a030 | #f2c46d | #1a1200 |
| Polls | #4fc3f7 | #8fd8fb | #04202c |
| Bounties | #ffb300 | #ffd54f | #2a1600 |
| Lotto (Pepeball) | #6a4a9c (purple field #2a0f4a) | #e1c7ff | #fff |
| Casino | #7ee08a on felt #14301f | — | #0b0f0c |
| GTF and gangs | #ffcf40, with #6fdc7b, #b98cff and #ff6b6b as part colours | — | #2a1600 |
| Support | #ff6a9b | — | #2a0010 |
| Plex | #ffa726 (Plex brand #e5a00d) | — | #1a1000 |
| Premium | #b388ff | — | #12002a |
| Achievements | #39ff88 | — | #02140a |

### 2.5 PAT gold

Gold always means PAT, money or prizes. Never use it as an area accent on a page that also shows balances, except GTF and the shop, whose accent *is* the loot.

| Token | Value | Use |
|---|---|---|
| `--ds-gold` | #ffcf40 | THE gold: eyebrows, pixel headings, focus ring, gold borders |
| `--ds-gold-2` | #ff8a3d | warm end of the gradient |
| `--ds-gold-text` | #ffe082 | big numbers (`.ds-pat`, `.ds-stat b.gold`) |
| `--ds-gold-grad` | linear-gradient(90deg, #ffcf40, #ff8a3d) | gold buttons, gold bars |
| `--ds-gold-text-grad` | 90deg #ffe680 → #ffcf40 → #ff8a3d | the one hero number (wallet balance, jackpot) |
| `--ds-gold-bg` / `--ds-gold-line` | rgba(255,215,64,.08) / #6b5a20 | gold cards, warn notes |
| `--ds-on-gold` | #2a1600 | text on gold (11.8:1, and 7.4:1 at the orange end) |

The aliases #ffd700, #ffd740, #ffc600, #ffc300 and #ffd54f in old page CSS all become `--ds-gold`, or `--ds-gold-text` for big numbers.

### 2.6 Semantic

| Role | Text | Fill (solid) | Tint bg | Border | Ink on tint |
|---|---|---|---|---|---|
| ok | `--ds-ok` #81c784 | `--ds-green` | `--ds-ok-bg` | `--ds-ok-line` #2e6b31 | `--ds-ok-ink` #d6f0d6 |
| warn | `--ds-warn` #f2c46d | `--ds-warn-fill` #e0a030 | `--ds-warn-bg` | `--ds-warn-line` #6b531e | `--ds-warn-ink` #efe2b8 |
| danger | `--ds-danger` #ffb3b3 (text), `--ds-danger-solid` #e57373 (numbers) | `--ds-danger-fill` #5a2a2a | `--ds-danger-bg` | `--ds-danger-line` #7a3a3a | `--ds-danger-ink` #f6c6c6 |
| info | `--ds-info` #9fc9ff | `--ds-info-fill` #2f5f99 | `--ds-info-bg` | `--ds-info-line` #2f4f7a | `--ds-info-ink` #d5e6fb |
| live | — | `--ds-live` #d32f2f to `--ds-live-2` #e64a19 | — | — | #fff (≥ 3.9 across the gradient, 4.98 at the start) |
| unread badge | — | `--ds-badge` #e53935 | — | — | #fff |

Up and down numbers use `--ds-ok` and `--ds-danger-solid`, and always carry a sign (+ / −, using the real minus U+2212 in display text) or an arrow (▲ ▼). Never rely on colour alone.

### 2.7 Rarity and platforms

Rarity: common #9aa4ad, uncommon #5fd17a, rare #b388ff, epic #ff4fd8, legendary #ffd740 (`--ds-r-*`).

Platforms: Twitch #9146ff, Discord #5865f2, Camfrog #a5d6a7, Plex #e5a00d. The `.pad-plat` badges in styles.css keep their tinted variants.

---

## 3. Typography

### 3.1 Fonts

| Token | Stack | Use |
|---|---|---|
| `--ds-font` | Ubuntu, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif | everything |
| `--ds-font-pixel` | "Press Start 2P", ui-monospace, monospace | eyebrows, pixel section headings, arcade numerals (lotto balls, credit score). Never body text, never below 9px, never for anything longer than about 4 words. It has no lowercase, so always uppercase it. |
| `--ds-font-mono` | ui-monospace, SFMono-Regular, Menlo, Consolas, monospace | ids (M-1042), hashes, code, provably-fair seeds |
| `--ds-font-emoji` | Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji | inside `.ds-ic` |

**Weights.** layout.ejs loads Ubuntu 400, 500, 700 and italic 400. Use 400 for body, 500 for gentle emphasis (`.ds-meta b`, tabs) and 700 for headings, buttons, chips and numbers. **Ubuntu has no 800 or 900.** The old `font-weight: 900` and `800` render as 700, so write 700. Before 1.99pj the font link loaded only 400, so every bold on the site was a synthesized faux-bold. That is fixed globally.

### 3.2 Type scale

The same on phone and desktop except the two `clamp()` headings, which scale with the viewport.

| Role | Class | Size | Line-height | Weight | Tracking | Colour |
|---|---|---|---|---|---|---|
| Display (hero h1) | `.ds-hero h1`, `.ds-display` | clamp(28px, 5vw, 40px), so 28 at 375 and 40 at ≥ 800 | 1.1 | 700 | −0.01em | text-strong |
| Page title (no hero) | `.ds-h1` | clamp(24px, 4.4vw, 30px) | 1.15 | 700 | −0.005em | text-strong |
| Section | `.ds-h2` (+ `.dot`) | 20px | 1.25 | 700 | 0 | text-strong |
| Pixel section (arcade pages) | `.ds-pixel-h` | 12px Press Start | 1.6 | 400 | .04em, uppercase | gold |
| Card title | `.ds-h3` | 17px | 1.3 | 700 | 0 | text-strong |
| Sub-heading | `.ds-h4` | 15px | 1.35 | 700 | 0 | text |
| Eyebrow | `.ds-eyebrow` (`.ac` for accent colour) | 10px Press Start | 1.7 | 400 | .12em, uppercase | gold |
| Lead | `.ds-lead` | 16px | 1.55 | 400 | 0 | text-2, max 68ch |
| Body | `.ds-body`, `.ds-page` default | 15px | 1.55 | 400 | 0 | text |
| Small | `.ds-sub` | 14px | 1.5 | 400 | 0 | text-muted |
| Meta | `.ds-meta` | 13px | 1.5 | 400 (b = 500) | 0 | text-muted |
| Fine print | `.ds-fine` | 12px | 1.45 | 400 | 0 | text-muted |
| Label (fields, column heads) | `.ds-label` | 12px (table th 11.5px) | 1.3 | 700 | .06em, uppercase | #b9b9b9 (th: text-muted) |
| Chip | `.ds-chip` | 11px | 1.6 | 700 | .05em, uppercase | per state |
| Mono | `.ds-mono`, `code` | 12.5px (code .9em) | 1.4 | 400 | 0 | #e8e8e8 |
| Hero number | `.ds-pat.xl` | clamp(34px, 8vw, 54px) | 1.05 | 700 | 0 | gold text gradient |
| Big number | `.ds-pat.lg`, `.bx-big` | 26px | 1.1 | 700 | 0 | gold-text |
| Stat number | `.ds-stat b` | 17px | 1.2 | 700 | 0 | text-strong |
| Long-form prose | `.ds-prose` | 15px | 1.65 | 400 | 0 | text, max 70ch, `>*+*` .85em |

Rules:

- **One display headline per page.** Pages with a hero use the display style. Pages without one (tools, settings, admin, detail pages) use `.ds-head` with an eyebrow, `.ds-h1` and `.ds-sub`.
- Headings use `text-wrap: balance`. Never center body copy. A hero can center only on a landing-style page with less than 3 lines of text.
- A gradient `em` inside the hero h1 (gold → orange, used by shop, economy, premium and support) is allowed **once per hero**, for 1 to 3 words. Use `background: var(--ds-gold-text-grad); background-clip: text; color: transparent`.
- Never use pixel-font h1s (achievements did). Use the display style with a pixel eyebrow.
- iOS zoom: any text field is at least 16px at phone widths. styles.css enforces this site-wide, and `.ds-in` is 15px on desktop.

### 3.3 Numbers

- **Always `font-variant-numeric: tabular-nums`** on PAT, counts, prices, timers and table columns. Use `.ds-num`, `.ds-pat`, `.ds-tbl` (whole table), `.ds-stat b` and `.ds-badge`.
- Format with the locale. Server side, use `t.num(n)`. In page JS, use `Number(n).toLocaleString(PATV_I18N?.lang)`. Use grouping separators always. Never use abbreviations (12.5k) in tables. Abbreviations are fine in chips, pills and badges (99+).
- **PAT display:** `<span class="ds-pat"><b>12,500</b><small>PAT</small></span>`.
  - The number is bold gold-text and the unit is .78em #d9c88a.
  - Variants are `.up`, `.down`, `.plain` (inherit colour), `.lg` and `.xl`.
  - Signed amounts carry +/−.
  - The unit is the word "PAT". Use the 🪙 coin only in buttons and toasts, never as a unit.
- Percentages have one decimal (4.2%). Odds and prices have two decimals (0.64). Durations use the localtime.js helpers.

---

## 4. Spacing

A 4px grid. Tokens are `--ds-sp-N`, where N × 4 = px. Half steps (`1h` = 6, `2h` = 10, `3h` = 14) exist for control internals.

| Token | px | Typical use |
|---|---|---|
| `--ds-sp-px` | 2 | hairline nudges, gap between menu items |
| `--ds-sp-1` | 4 | icon to label in tight chips |
| `--ds-sp-1h` | 6 | chip gap, tabs gap, label to input |
| `--ds-sp-2` | 8 | icon to label, button gap, stat grid gap |
| `--ds-sp-2h` | 10 | inside a card (`.ds-card` gap), row gap |
| `--ds-sp-3` | 12 | between cards in a grid, form field gap |
| `--ds-sp-3h` | 14 | note padding |
| `--ds-sp-4` | 16 | **card padding**, mobile gutter, section heading to content |
| `--ds-sp-5` | 20 | large card padding, hero side padding (mobile) |
| `--ds-sp-6` | 24 | **between page sections** (`.ds-page` gap) |
| `--ds-sp-8` | 32 | hero padding (≥ 700), major section breaks |
| `--ds-sp-10` | 40 | — |
| `--ds-sp-14` | 56 | page bottom padding before the footer |

Rhythm:

| Context | Value |
|---|---|
| Page top padding | 16 |
| Page sections | 24 |
| Section heading to its content | 12–16 |
| Card padding | 16 (`.lg` 20, never under 16 on phones) |
| Inside a card | 10 |
| Card grid gap | 12 |
| Paragraph spacing in prose | .85em |

---

## 5. Shape, elevation, layers, layout

### 5.1 Radii

| Token | px | Use |
|---|---|---|
| `--ds-r-xs` | 6 | code, `.ds-ref`, nav links in dense lists, kbd |
| `--ds-r-sm` | 8 | icon buttons, menu items, nav controls |
| `--ds-r-md` | 10 | inputs, selects, checks, stat tiles, `.ds-btn.square` |
| `--ds-r-lg` | 12 | notes, flat cards, popovers, subnav bar, toasts |
| `--ds-r-xl` | 16 | **cards**, tables, empty states, compact hero |
| `--ds-r-2xl` | 18 | **heroes**, modals, sheets |
| `--ds-r-pill` | 999 | buttons, chips, tabs, pills, badges, bars |

A nested element's radius is the outer radius minus the padding, with a minimum of 6. Example: a well inside a 16-radius card with 16 padding uses 12 (`--ds-r-lg`), never 16.

### 5.2 Elevation

| Token | Value | Use |
|---|---|---|
| `--ds-e-1` | 0 1px 0 rgba(255,255,255,.03), 0 1px 3px rgba(0,0,0,.45) | header bar (alias `--shadow-elevation-1`) |
| `--ds-e-2` | 0 8px 24px rgba(0,0,0,.35) | hovered link card |
| `--ds-e-3` | 0 10px 30px rgba(0,0,0,.45) | popovers, menus, toasts |
| `--ds-e-4` | 0 24px 64px rgba(0,0,0,.6) | modals, sheets |
| `--ds-glow` | 0 0 10px var(--ds-ac) | accent dot, live dot |

Cards at rest have **no shadow**; their border does the work.

### 5.3 Z-index

| Token | Value | Layer |
|---|---|---|
| `--ds-z-raised` | 1 | overlapped bits inside a card |
| `--ds-z-sticky` | 10 | sticky subnav, sticky table heads |
| `--ds-z-nav` | 50 | site navbar |
| `--ds-z-pop` | 60 | dropdowns, popovers |
| `--ds-z-sheet` | 100 | bottom sheets, side drawers |
| `--ds-z-modal` | 200 | modals (the legacy `.modal` is 200 too) |
| `--ds-z-toast` | 300 | toasts |

Never use 9999.

### 5.4 Breakpoints

CSS can't use variables in media queries, so these are the only widths to write. They are mobile-first, `min-width` unless noted.

| Width | Name | What changes |
|---|---|---|
| `max-width: 420px` | xs | Navbar tightens. Stack two-column rows. |
| `max-width: 520px` | phone | Card padding stays 16. Hero padding 24/20. |
| `max-width: 600px` | — | Modals become bottom sheets (`.ds-scrim.sheet`). |
| `700px` | — | Hero padding 32. |
| `max-width: 760px` / `761px` | tablet | The ☰ menu replaces the top bar. Gutter 16 below, 20 above. |
| `1000px` | desktop | `.ds-split` becomes main + 320px rail. |
| `1100px` | wide | Gutter 24. More menu in 2 columns. |
| `1280px` | xl | Navbar search box. |

`(pointer: coarse)` raises `.ds-btn.sm` and `.ds-tab` to 40px. The old 380, 480, 560, 640, 820, 860 and 900 breakpoints should collapse onto these when a page is polished.

### 5.5 Containers and gutters

`.ds-page` gives `max-width: var(--ds-w)`, `margin-inline: auto`, `padding: 16px var(--ds-gutter) 56px`, and a one-column grid with a 24px gap.

| Class | Token | Width | Use |
|---|---|---|---|
| `.ds-page.narrow` | `--ds-w-narrow` | 560 | sign-in, single-form pages |
| `.ds-page.read` | `--ds-w-read` | 760 | legal, guides, long text |
| `.ds-page.mid` | `--ds-w-mid` | 900 | a single item (poll, bounty, order, market) |
| `.ds-page` | `--ds-w-page` | 1040 | the default |
| `.ds-page.wide` | `--ds-w-wide` | 1200 | grids, a feed with a rail, shop |

`--ds-gutter` is 16px below 760, 20px at ≥ 760 and 24px at ≥ 1100. Never less than 16 on mobile. The home page (1400) and full-bleed game tables (casino felt, GTF map) may exceed `wide`, but keep the gutter.

Grids:

- `.ds-grid`: `repeat(auto-fill, minmax(min(100%, var(--ds-col, 300px)), 1fr))`. `.sm` is 220 and `.lg` is 340.
- `.ds-split`: main + 320px rail from 1000px.
- **Every grid or flex child that can hold long text gets `min-width: 0`.** ds containers set `grid-template-columns: minmax(0, 1fr)` for you. That is what stops a scrolling tab row or a table from widening the page.

---

## 6. Components

Each entry gives the anatomy, the sizes, the states and the do/don't. Live examples are on `/styleguide`.

### 6.1 Button: `.ds-btn`

- **Anatomy:** an inline-flex pill with an optional leading `.ds-ic` (1.05em) and a label. The icon gap is 8 (6 on `.sm`).
- **Sizes:** default min-height 44, padding 0 20, 15px/700. `.sm` is 36 (40 on touch), padding 0 14, 13.5px. `.lg` is 52, padding 0 24, 16px. `.icon` is a 44 square at radius 10; `.icon.sm` is 36 at radius 8. `.wide` is full width. `.square` uses radius 10 for dense toolbars and admin.
- **Variants:**
  - default: accent fill with `--ds-on-ac` ink
  - `gold`: the PAT action (buy, stake, claim)
  - `ghost`: secondary, a transparent fill with a #333 border that turns accent on hover
  - `quiet`: tertiary, a #1c1c1f fill
  - `danger`: destructive
  - `warn`
  - `info`
  - `live`: Go live / stream only
  - `link`: a text button
- **States:**
  - hover: brightness 1.1 (ghost and quiet change their border or fill instead)
  - active: translateY(1px)
  - focus-visible: `--ds-focus-ring` (2px bg gap + 2px gold)
  - disabled, `aria-disabled` or `aria-busy`: greyscale .6 + brightness .7, `not-allowed`
  - busy buttons keep their width; swap the label for "…ing…"
- **Do:**
  - one filled primary per view region (a card, a form, a hero);
  - verb-first labels (Place bet, Claim 500 PAT);
  - gold only for spending or claiming PAT.
- **Don't:**
  - white text on green;
  - more than 2 CTAs in a hero;
  - mixing pill and square buttons in one row;
  - buttons under 36px tall.

### 6.2 Chips, tags, badges, tabs

- **`.ds-chip` (status):**
  - a 7px dot in currentColor plus an UPPERCASE label;
  - 11px/700, .05em tracking, padding 3 10, pill;
  - states are `live` (pulsing dot), `ok`, `warn`, `gold`, `danger`, `info`, `mute` and `solid-live`, plus `.plain` with no dot;
  - the chip vocabulary maps from bets.css: open/live become `live` or `ok`; closed/waiting/settling become `warn`; settled/won/resolved become `gold`; void/expired/cancelled become `mute`; disputed/late become `danger`; proposed/ai become `info`.
- **`.ds-tag`:** a sentence-case label (platform, tier, category). 11px/700, padding 1 8, #333 border. `.ac` gives an accent tint.
- **`.ds-ref`:** a mono id (M-1042), accent tint, radius 6.
- **`.ds-badge`:** an unread counter. 18px tall, min-width 18, red, 11px/700 tabular. Show 99+ above 99. It always sits at the top-end corner of its 40px host.
- **`.ds-tabs` > `.ds-tab`:**
  - filter chips and section tabs;
  - pills 36px tall (40 on touch), padding 0 14, 13px/500, #151515 fill and #2a2a2a border;
  - current state is `.on`, `aria-current="page"` (links) or `aria-selected="true"` (tablist), shown with an accent border, accent tint and white text;
  - optional `.ds-count`;
  - the row scrolls horizontally on phones without a scrollbar; add `.wrap` to wrap instead;
  - inside a sticky bar, use `.ds-subnav` (12 radius, blurred, top 0).
- **`.ds-seg`:** a segmented control for 2–4 mutually exclusive view modes (List / Gallery). It uses `aria-pressed`.
- **Don't** use chips as buttons. A clickable pill is a `.ds-tab`.

### 6.3 Card: `.ds-card`

- **Anatomy:**
  - optional `.ds-card-h` (ref + chip, space-between);
  - title `.ds-h3`;
  - `.ds-meta`;
  - content;
  - optional `.ds-card-f` footer, divided by a soft line.
- **Box:** `--ds-surface`, 1px `--ds-line`, radius 16, padding 16, grid gap 10.
- **Variants:**
  - `.lg`: padding 20, gap 12
  - `.flat`: a sunken well, radius 12, padding 12 14
  - `.hl`: selected or yours, accent border plus inset ring
  - `.gold`: money
  - `.top`: a 3px accent top rule for parts, tiers and sections
  - `a.ds-card` / `.link`: a whole-card link that lifts 1px and takes `--ds-e-2` and the accent border on hover
- **Lists in cards:** `.ds-list` > `li`. Each row is at least 44px tall, rows are divided by soft lines, and a `.grow` cell takes the slack. Use `.ds-ic.tile` for activity icons.
- **Don't** nest a card in a card. Use `.flat` for the inner one.

### 6.4 Hero: `.ds-hero`

- **Anatomy:**
  - `.ds-eyebrow` (gold Press Start, 10px)
  - h1 (display)
  - `.ds-lead`
  - `.ds-ctas` (≤ 2 buttons)
  - `.ds-pills` of `.ds-pill-stat`
- **Box:**
  - radius 18;
  - padding 24/20/20 on phones and 32/32/28 at ≥ 700;
  - 1px `--ds-line`;
  - background: `radial-gradient(90% 140% at 100% 0%, var(--ds-ac-bg), transparent 60%), radial-gradient(70% 120% at 0% 100%, rgba(255,215,64,.07), transparent 60%), #111`.
- **Variants:**
  - `.compact`: radius 16, h1 at page-title size, for sub-pages
  - `.gold`: a money page (wallet, economy, premium); a radial #2a2208 glow top-start
  - Area heroes (lotto purple, casino felt, GTF red/green, support pink) may replace the background recipe. Keep the radius, padding, type and anatomy.
- **Stat pills:** padding 7 13, pill, `--ds-glass` bg, #333 border, 13px label with the value in `b` at 15px/700 tabular.
- **No hero** (`.ds-head`): eyebrow, `.ds-h1`, `.ds-sub`, gap 6. Use it on tool, settings and admin pages.

### 6.5 Stat tiles: `.ds-stats` > `.ds-stat`

- A grid of `auto-fit, minmax(120px, 1fr)` with an 8px gap.
- Each tile: sunken bg, soft border, radius 10, padding 10 12.
- `span` is the label (11px/700, uppercase, .06em, muted). `b` is the value (17px/700 tabular; `.gold`, `.up` and `.down` set colour). `small` is the footnote.
- Inside a hero, tiles use `--ds-glass`.

### 6.6 Section heading: `.ds-h2`

- 20px/700 white, flex, gap 8 10.
- `.dot` adds a 10px accent dot with glow.
- `.ds-count` is a grey count pill.
- `.ds-h-aside` is an end-aligned link ("See all →").
- Arcade pages may use `.ds-pixel-h` (12px gold Press Start) instead. Use one heading style per page, never both.

### 6.7 Forms

- **`.ds-field`:** a grid with a 6px gap. It holds `.ds-label` (12px/700 uppercase), then the control, then `.ds-hint` (12px muted) or `.ds-err` (12px danger).
- **Control (`.ds-in` / `.ds-select` / `.ds-textarea`):**
  - min-height 44, padding 10 12, radius 10, sunken bg, #333 border, 15px (16px on phones);
  - hover border #444; focus: accent border plus a 3px accent halo;
  - `aria-invalid="true"` gives a red border;
  - disabled has .5 opacity.
- **Select:** a CSS chevron at the end. RTL is handled.
- **Textarea:** min 96px, vertical resize, 1.5 line-height.
- **Input group:** `.ds-in-group` > `.ds-in` + `.ds-in-addon`, for a unit such as PAT.
- **Checkbox row:** `.ds-check`, 44px tall, a bordered row with a 20px accent checkbox.
- **Switch:** `.ds-switch` (42×24) for on/off settings that apply immediately.
- **Quick amounts:** `.ds-quick` (36px pills, tabular).
- **Layout:** `.ds-form` (grid gap 12); `.ds-form-row` (auto-fit 190px columns); `.ds-actions` (button row, gap 10).
- **Rules:**
  - Every control has a visible label. A placeholder is an example, not the label.
  - Errors appear inline under the field and in a `.ds-note.danger` above the submit button for server errors.
  - Use `inputmode="numeric"` on amounts.
- **Legacy trap:** styles.css styles `input[type=text|email|password|number]` globally (black text, #ddd border, margin 10/15). The ds classes are written doubled (`.ds-in.ds-in`) to beat it. In a page's own CSS, reset `margin`, `color` and `border` if it isn't using `.ds-in`.

### 6.8 Tables: `.ds-tbl` > `table`

- **Wrapper:** `overflow-x: auto`, `--ds-surface`, 1px line, radius 16. Wide tables scroll *inside* it, never the page.
- **Cells:** 13.5px, tabular, padding 10 12, soft row dividers, vertical-align middle.
- **Head (`th`):** 11.5px/700 uppercase .06em, muted on #151515, sticky top.
- **Alignment:** `.r` for numbers (always end-aligned, `nowrap`), `.c` centred.
- **Variants:** `tr.tot` is a gold total row; `.dense` uses padding 6 10.
- On phones, prefer a card list for tables over 4 columns.

### 6.9 Notes, toasts, empty states, loading

- **`.ds-note`:** a flex row of `.ds-ic` + `div`, padding 12 14, radius 12, 14px/1.5.
  - Kinds: neutral, `ok`, `warn` (gold tint), `danger`, `info`.
  - A leading `b` gives the summary ("Saved.").
  - Use it for persistent page messages. Use flash messages (connect-flash) here.
- **`.ds-toast` in `.ds-toasts`:** fixed bottom, centred, max 440 wide, surface-3, radius 12, `--ds-e-3`.
  - Use it for transient confirmations after an in-page action.
  - Auto-dismiss after 3–4 s. The container has `aria-live="polite"`.
- **`.ds-empty`:** dashed #333 border, radius 16, padding 24 16, centred. It holds a 30px emoji, `b` title, one line of help and an optional `.ds-btn.sm` CTA. Every list needs one, and the copy says what to do next.
- **`.ds-skel`:** shimmer blocks, radius 8, for content loading in place. Size them like the content.

### 6.10 Popovers, menus, modals, sheets

- **`.ds-pop`:** surface-3, menu border, radius 12, padding 6, `--ds-e-3`, z 60. Items are `.ds-menu-item` (40px, radius 8, icon + label; `.danger`). Separate groups with `hr.ds-divider`. Use `<details>` for no-JS menus, as the navbar does.
- **`.ds-scrim` > `.ds-modal`:**
  - The scrim is fixed, blurred and z 200.
  - The modal is at most 520 wide, radius 18, padding 20, surface-3, `--ds-e-4`.
  - Its parts are `.ds-modal-h` (h2 18px + `.ds-close` 36px) and `.ds-modal-f` (end-aligned buttons, cancel first, primary last).
  - Behaviour: focus moves into the modal and returns on close; Esc and a click on the scrim close it.
- **Sheet:** add `.sheet` to the scrim. Under 600px it docks to the bottom, full width, with top-only radii and safe-area padding.
- Use a modal only for confirmations and short forms. Anything longer is a page.

### 6.11 Avatars: `.ds-av`

- Sizes: xs 24, sm 32, default 40, lg 64, xl 96.
- Always round and always `object-fit: cover`. Placeholder bg is #1a1a1a.
- `.ring` is the accent ring (you / live). `.px` is pixel-art (heist and GTF avatars): radius 10 and `image-rendering: pixelated`.
- Next to a name: gap 8 (24–32px) or 10 (40px), with the name `.ds-truncate`.

### 6.12 Progress: `.ds-bar`

- Track: #1f1f1f, pill, 10px high (`.sm` 6, `.lg` 14). Fill: accent (`.gold` uses the gold gradient).
- Width animates .35s.
- Pair it with a visible value. The bar never carries information alone.

### 6.13 Pagination and back links

- **`.ds-pager`:** 40px pills, tabular. The current page is `aria-current="page"` (accent). Use `.gap` for "…" and ‹ › with aria-labels.
- **`.ds-back`:** "← Back to …", 14px accent, 36px tall. It sits at the top of a detail page, above the hero.

### 6.14 Navigation (the global shell)

The shell is defined in views/layout.ejs; see §10. Page-level navigation uses `.ds-tabs` (filters or sections) or `.ds-subnav` (sticky jump links on long pages). Don't build new top bars inside pages.

---

## 7. Icons and emoji

PATV's icons are emoji plus a few PNGs (Pepe, star.gif, Discord, Twitch, coin). The rules for using them:

1. **Wrap every icon that sits next to text in `.ds-ic`.** It is a square inline-flex box (1.25em by default) with `vertical-align: -.25em` and `line-height: 1`, so the glyph's centre lands on the text's centre line. Emoji fonts sit high in Ubuntu's line box, and a bare emoji rides about 2px above centre. `img` and `svg` inside fill the box with `object-fit: contain`.
2. **Sizes by context:**

| Context | Size |
|---|---|
| Inline in body text | 1.25em (default) |
| Chips and tags | `.xs` 14 |
| Buttons | 1.05em of the label, so 16 at 15px |
| Nav links and menu items | `.md` 20 box, 16–17 glyph |
| Section icons | `.lg` 24 |
| Empty states | 30 |
| Activity rows | `.tile` 36 box, 18 glyph |
| Hero feature tiles | `.xl` 32 |

3. **Flex parents align with `align-items: center`.** Never nudge an icon with `position: relative; top: 1px`. If something looks off, the icon is missing its box.
4. **Decorative icons get `aria-hidden="true"`.** Icon-only buttons get an `aria-label`, and a `title` when a sighted hint helps.
5. **Image icons** have an explicit `width` and `height` (no layout shift) and `alt=""` when decorative.
6. **One emoji per label, leading, never trailing**, except → in "See all →". Emoji are not bullets in running text.
7. `.ds-ic.mono` (60% greyscale) is for chrome icons that should be quiet until hovered (navbar 💬 🔔 🔍).
8. Variation selectors matter. Write ✈️, 🗳️, 🎟️ and ⚠️ with U+FE0F, or Windows draws the monochrome text glyph.

---

## 8. Motion

| Token | Value | Use |
|---|---|---|
| `--ds-dur-1` | .12s | hover, press |
| `--ds-dur-2` | .2s | menus, toggles, card lift |
| `--ds-dur-3` | .35s | entrances, bars |
| `--ds-ease` | cubic-bezier(.2,.7,.2,1) | — |

- **Allowed motion:**
  - a 1px lift on hover (cards, gold buttons);
  - brightness 1.1;
  - a 6px fade-up entrance (`.ds-anim` staggers children by 40ms);
  - the live-dot pulse (1.8s);
  - skeleton shimmer;
  - bar width.
- **Game pages may animate more** (wheel, Pepeball draw, cards dealt, GTF map), but within the same reduced-motion rule.
- **Reduced motion.** `@media (prefers-reduced-motion: reduce)` kills every animation and transition on `[class*="ds-"]`. A page with its own motion must add the same block for its own classes, or gate decorative motion behind `(prefers-reduced-motion: no-preference)`. Never autoplay a flashing effect faster than 3 Hz.

---

## 9. Accessibility, i18n and RTL

- **Contrast.**
  - Body text ≥ 4.5:1 and large text (≥ 18.66px bold or 24px) ≥ 3:1. Every text token passes 4.5 on every surface.
  - Text on fills: white only on fills ≥ 4.5:1 (#2f5f99, #d32f2f, #5a2a2a). Dark ink on bright fills (green, gold, amber, cyan, pink).
  - **Known legacy fail:** `styles.css`'s global `button` (white on #3cc47c, 2.2:1) and the old #4caf50 buttons with white text. Fix them per page during polish by switching to `.ds-btn`.
- **Focus.** Every interactive element shows `:focus-visible`: a 2px solid `--ds-focus` (#ffcf40) outline with a 2px offset, or `--ds-focus-ring` (box-shadow) on pills. Never `outline: none` without a replacement. `.ds-page` applies the outline to plain links, buttons and fields automatically.
- **Tap targets.** At least 44×44 for primary controls. 36 is allowed for secondary or compact controls (`.sm`, tabs) on desktop; touch raises them to 40. Inline text links are exempt but get `text-underline-offset: 3px`.
- **Semantics.**
  - One `<h1>` per page, and headings in order.
  - `<main>` wraps the page.
  - Tables have `<th>`. Lists are `<ul>`.
  - Icon-only controls have `aria-label`.
  - Live regions: toasts are `aria-live="polite"` and form errors are `aria-describedby`.
  - Use `.ds-sr-only` for text that only screen readers need.
- **Zoom.** Never `maximum-scale` or `user-scalable=no` (test/mobile-ux.test.js). Fields are ≥ 16px on phones.
- **i18n.** Strings come from `t('key')` server side and `__t('js.key', 'Default')` in page JS. New keys go in `locales/en.json` only. Translated labels run up to 40% longer than English, so:
  - buttons and tabs never have a fixed width;
  - single-line labels in tight chrome ellipsize (`max-width` + `text-overflow`);
  - everything else wraps (`overflow-wrap: anywhere` on `.ds-page`).
- **RTL.** The site ships RTL locales (`<html dir="rtl">`). Use logical properties everywhere:
  - `margin-inline-start` not `margin-left`, `padding-inline-end`, `inset-inline-start`, `border-inline-start`, `text-align: start/end`;
  - `border-start-end-radius` for the input-group addon.
  - Directional glyphs (→ ‹ ›) are content; flip them in RTL with `[dir="rtl"] .x { transform: scaleX(-1) }` or provide the mirrored character.
  - ds.css is fully logical. Its only physical values, the switch thumb and the select chevron, have `[dir="rtl"]` overrides.
  - Test with the RTL toggle on /styleguide.

---

## 10. The global shell (views/layout.ejs)

As of 1.99pj.

- **Head.**
  - One Google Fonts request (Press Start 2P + Ubuntu 400/500/700/400i, `display=swap`) with preconnects.
  - Then `ds.css?v=N`, then `styles.css?v=N`.
  - Bump `?v=` on every change to either file.
  - `theme-color` is #18181b (the header), not green.
- **Header bar.**
  - `--ds-surface-2`, `--ds-e-1`, a 1px bottom line #202024.
  - Navbar min-height 64 (58 at ≤ 760), padding 12/20 (10/12, then 10/8 at ≤ 420).
- **Wordmark.** `--ds-brand`, 20px/700 (18 on phones). It switches to "PATV" at ≤ 960.
- **Top-bar links (`.nav-link`).**
  - 40px tall, radius 8, #9b9ba3 → white on hover with an `--ds-hover` fill.
  - The current page gets #1f2b22 and a 2px brand underline.
  - Icons sit in a 20×20 box (`.ic`, emoji 17px, img 16px).
- **More / ☰ menus.**
  - `--ds-surface-3` popover, radius 12, `--ds-e-3`.
  - Section headings are 11px/700 uppercase #9a9aa6 (it was #7f7f8c, which failed AA).
  - Links are 40px (44px in the phone menu's 2-column grid).
  - The More chevron rotates when open.
  - A click outside **or Esc** closes the menu, and Esc returns focus to its summary.
- **CTAs.** Post and Go live share one pill base: 34px, min-width 104, 14px bold, icon box 18×18.
  - Post is green-deep with a #3c7a46 outline.
  - Go live is the `--ds-live` gradient (#d32f2f → #e64a19; was #e53935 → #ff7043, which was 2.7:1 at the end).
  - Both are icon-only squares at ≤ 500. Sign in uses the same 34px pill.
- **Icon buttons (💬 🔔 🔍).** 40×40, radius 8, 60% greyscale until hovered or unread. The unread badge is `--ds-badge` with a 2px header-coloured ring, anchored with `inset-inline-end`.
- **Search.**
  - ≥ 1280: a 34px pill input; it widens to 210 on focus with a green halo; the 🔍 is centred with `top: 50%` and `translate`.
  - 1000–1279: a 40px 🔍 button.
  - Below 1000: the first row of the More / ☰ menus, a 40px field + a 40×40 button.
- **Avatar.** 40px round (36 at ≤ 420), `object-fit: cover`, 1px ring.
- **Focus.** Every navbar control shows the gold 2px focus outline.
- **Footer.**
  - #0c0c0e, a top line `--ds-line`, 13px/1.6.
  - Text uses `--ds-text-faint` (was #777, which failed AA). Links are #a3a3a3 with a 32px hit area.
  - Bottom padding includes the safe area. The language select is 36px.
- **Stale-account banner.** An ok-tinted note, radius 12, with a 36px dismiss button and logical insets.

---

## 11. Page recipes

**Landing or area page** (markets, wagers, shop, lotto, GTF):

```html
<main class="ds-page" style="--ds-ac: …">
  <section class="ds-hero">eyebrow · h1 · lead · ctas · pills</section>
  <nav class="ds-tabs">filters</nav>
  <h2 class="ds-h2 dot">Open <span class="ds-count">12</span></h2>
  <div class="ds-grid">cards…</div>   <!-- or .ds-empty -->
</main>
```

**Detail page** (a market, a bounty, an order): `.ds-page.mid` containing `.ds-back`, then `.ds-hero.compact` (ref + chip in the eyebrow row), then `.ds-split` (main column of cards / rail with the action card).

**Tool, settings or admin page:** `.ds-page`, then `.ds-head`, then `.ds-card.lg` forms with `.ds-field`s and `.ds-tbl` lists. The admin shell (partials/admin-open) keeps its sidebar; inside `.adm-main`, use the same components.

**Legal or long text:** `.ds-page.read`, then `.ds-head`, then `.ds-prose`.

---

## 12. Audit: what the redesigns disagreed on (October 2026) and what won

Measured across views/*.ejs, views/partials/* and public/css/*. In total there are 6,309 hard-coded hex values, of 1,113 distinct colours, and about 120 distinct dark greys between #050505 and #2f2f2f.

| Thing | Found | Standard |
|---|---|---|
| Card radius | 10, 12, 14, 16, 18 | **16** (`--ds-r-xl`) |
| Hero radius | 16, 18, 20, 22, 24, and 18 18 0 0 | **18** (`--ds-r-2xl`) |
| Card padding | 12 / 12 14 / 14 / 14 16 / 16 / 16 18 / 18 / 20 / 22 | **16** (`.lg` 20) |
| Card background | #111, #121212, #121214, #0f0f0f, #141414, #141418 | **#121212** `--ds-surface` |
| Card border | #222, #232323, #262626, #2a2a2a, #27252b, #26262d, #2c2c2c, #2d2d2d, plus 2px borders | **1px #262626** `--ds-line` |
| Muted text | #888 (150×), #8a8a8a, #8d8d8d, #8f8f8f, #9a9a9a, #999, #aaa, #a7ada7, #777, #666… | **#9a9a9a** muted, **#8e8e8e** floor |
| Gold | #ffd700 (134×), #ffcf40 (93×), #ffd54f, #ffc600, #ffe082, #ffd740, #ffc300, #ffc400, #c9a400… | **#ffcf40** + #ffe082 for numbers |
| Gold button | 90deg #ffcf40→#ff8a3d (wallet, shop, premium, GTF) vs 180deg #ffe57f→#ffc400 (bets, casino, lotto) vs #ffd700→#ffb300 (help) | **90deg #ffcf40→#ff8a3d** |
| Green | #4caf50 (218×), #81c784 (112×), #3cc47c, #66bb6a, #43a047, #5fd06b, #6fdc7b, #7ee08a, #c6e94f lime (63×)… | **#4caf50 / #81c784**; #3cc47c is the wordmark only; lime retires (auth and legal move to green) |
| Button height | none, 32, 34, 36, 38, 40, 44, 46, 48, 54, 56 | **44** (sm 36, lg 52) |
| Button radius | 6, 8, 9, 10, 12, 14, 999 | **pill**; `.square` 10 for dense UIs |
| Primary button text | white on #4caf50 (2.8:1) | **dark ink #04150a** (6.8:1) |
| h1 size | clamp maxes 28/30/36/38/40/44/46/52/54; fixed 24 and 26; line-heights 1.05–1.25; one pixel-font h1 | **clamp(28px, 5vw, 40px)/1.1** |
| Eyebrow | PS2P 10px .12em mostly; 9px, .14em, .5px variants; colours #ffcf40, #c6e94f, #4caf50, #b98cff, #3de8ff; line-heights unset/1.6/1.7/1.8 | **PS2P 10px/1.7 .12em #ffcf40** (`.ac` for accent) |
| Section h2 | PS2P 9–12px in #ffd700 or #ffcf40, *or* Ubuntu 16–22px | **Ubuntu 20px/700 white + dot**, or `.ds-pixel-h` 12px gold (one per page) |
| Focus ring | 2px or 3px; #ffcf40, #ffd700, #ffd740, #c6e94f, #fff, #3cc47c, #4AFFEF; offsets −2 to 2; six files had none | **2px #ffcf40, offset 2** |
| Inputs | radius 6/8/10/12, heights 38–46, bg #070707–#0d0d10, 1px or 2px borders | **44px, radius 10, #0c0c0c, 1px #333** |
| Chips | radius 4, 8, 14, 16, 999; font 11–14px; PS2P 8.5px in GTF | **pill, 11px/700 uppercase** (status), 13px tabs |
| Breakpoints | 17 distinct widths | **420 / 520 / 600 / 700 / 760 / 1000 / 1100 / 1280** |
| Reduced motion | missing on economy, gangs, premium | required everywhere |
| Font weights | 800 and 900 asked for, but only Ubuntu 400 loaded (faux bold) | 400/500/700 loaded; ask for 700 |

**Global bugs fixed in 1.99pj:**

- styles.css `.avatar img` had `// comments`. CSS has no line comments, so `object-fit: cover` was silently dropped and non-square avatars stretched.
- A nested `/* */` left a stray `} */`, which made the next selector `*/ *`. That selector is invalid, so the thin dark scrollbar rule (`scrollbar-width` / `scrollbar-color`) never applied.
- The header's `box-shadow: var(--shadow-elevation-1)` pointed at an undefined variable; it is now an alias of `--ds-e-1`.

---

## 13. Checklist for a polished page

- [ ] Wrapped in `.ds-page` (right width), no horizontal scroll at 360, 375, 768, 1280 and 1440.
- [ ] One h1. The hero or head follows §6.4. Section headings are all one style.
- [ ] No raw hex where a token exists. Cards are surface/line/16/16. The hero is 18.
- [ ] Buttons are `.ds-btn` (44, pill, dark ink on bright fills). No white-on-green.
- [ ] Every icon next to text is in `.ds-ic`. Decorative icons are `aria-hidden`.
- [ ] Numbers are tabular. PAT uses `.ds-pat`. Amounts are locale-formatted and signed when they are deltas.
- [ ] Every list has a `.ds-empty`. Every form has labels, hints and inline errors.
- [ ] Focus is visible on everything. Tap targets ≥ 44 (36 for secondary). Fields ≥ 16px on phones.
- [ ] Logical properties only. Checked with `dir=rtl`. Long translated labels wrap or ellipsize.
- [ ] Motion respects `prefers-reduced-motion`.
- [ ] Bump `?v=` on any CSS file changed, and run `npm test`.

---

## Area notes: profile, account and auth

Added by the 1.99pm polish pass (profile, Edit profile, sign-in pages, language, Telegram, translate, 404). These pages all keep the PATV green accent.

### Auth page (sign in, register, forgot / reset password, Plex / SSO "new account", account-conflict)

- `main.ds-page.narrow.au` > `section.ds-card.lg.au-card`, then an optional `p.au-foot` link line under the card. The page gap is 16, not 24, so the foot line stays attached to its card.
- **Card anatomy:** a brand row (`.au-brand`: 36px pixel Pepe + `.ds-eyebrow` "publicaccess.tv"), `.ds-h1`, `.ds-sub`, then notes (`.ds-note.ok` / `.ds-note.danger` with `.au-alert`), then the form.
- **Card background:** a soft green glow at the start corner, `radial-gradient(120% 90% at 0% 0%, var(--ds-green-bg), transparent 60%)` over `--ds-surface`. The lime (#c6e94f) focus rings and eyebrows are retired. Focus is the standard gold.
- **Form:** fields are `.ds-field.au-field` with `input.ds-in` at 16px on every width; the gap between fields is 14. A password field wraps the input in `.au-pw` with a 36px "Show" text button inset 4px from the end, so the input reserves 76px of end padding.
- **Submit:** `.ds-btn.lg.wide` (52px, full width) with a spinner that takes `currentColor`, so it reads on dark ink. A second, alternative action is `.ds-btn.lg.wide.ghost`. A tertiary "Cancel" is `.au-linkbtn`, an underlined muted text button 36px tall, centred under the card's actions.
- **Sub-sections inside the card** ("New to PATV?" / "Already have an account?") use `.ds-h3`, divided by the `.au-or` rule (12px uppercase, `--ds-text-faint`, 1px `--ds-line` rules either side).
- **Sign in with… buttons (`.au-oauth`):** 44px pills, 15px/700, a 20px brand mark plus the label, in a 2-column grid (1 column at ≤ 420). Plex spans both columns. Fills are the platform tokens with white ink, **except** Telegram, whose #229ED9 is 3.0:1 against white: it uses #1a7bb0 (4.7:1). Google is the white button with #1f1f1f ink and a #dadce0 border, per Google's guideline. Plex is `--ds-plex` with dark ink.
- **Summary rows** (`.au-sum`, the account-conflict "Signed in as / Other account / PAT it brings"): a sunken well, radius 12, rows of 10/14 padding divided by soft lines, key muted, value bold and end-aligned; a PAT value uses `.v.gold` (gold-text, tabular).
- **Perks row** (register): `.ds-tag.ac` pills at 12px/500 with a leading `.ds-ic`. They wrap.
- **JS hooks to keep:** `form[data-au-form]`, `[data-rule]`, `.au-pw .eye`, `#<field>-err`, `.au-hint` (`.ok` is toggled by the strength meter), `.au-caps`, the submit's `.lbl` and `data-busy`.

### Tool or settings page with no hero (language, translate, Telegram)

- `.ds-page.read` (a list of choices) or `.ds-page.mid` (cards of settings), then a `div.ds-head`, then `.ds-card.lg` sections with `.ds-h3` titles.
- **Gotcha: never put `.ds-head` on a `<header>` element.** styles.css styles every `header` as the site bar (#18181b fill, the header shadow, green text). Use `<div class="ds-head">`.
- **Choice tiles** (the language list): a `repeat(auto-fill, minmax(min(100%, 200px), 1fr))` grid, gap 8, each tile 44px tall, radius 10, `--ds-surface` with a `--ds-line` border; hover turns the border accent; the current one is `.on` (accent border + accent tint) with `aria-current`.
- **Checkbox grids** (Telegram alert kinds): `.ds-check` rows in a `minmax(min(100%, 260px), 1fr)` grid with an 8px gap. An icon goes in its own `span.ds-ic` between the box and the label, never in the label text.
- A heading with its list (translate's "From the page you were on") is wrapped in a `.ds-stack` so the heading-to-content gap is 12, not the page's 24.
- **Collapsible inline form:** a `details > summary.ds-btn.ghost.sm` (marker hidden) that opens a `.ds-form` of `.ds-field`s, submit `.ds-btn.sm` in `.ds-actions`.

### Not found / forbidden (notFound.ejs)

`.ds-page.narrow`, centred: a 64px `.ds-ic` frog, `.ds-h1`, a `.ds-lead` (max 46ch), then `.ds-actions` centred with one filled `.ds-btn` (Home) and `.ds-btn.ghost` for the rest. 48px top padding. This is the one place body text is centred (§3.2 allows it on a landing-style page under 3 lines).

### Profile (/u/:name and its tabs) and Edit profile (/u/:name/edit)

- **Profile:** `main.ds-page.pf` (default 1040 width), page gap 16. The summary card is a hero (radius 18, green glow at the start corner) holding identity, the stat strip and the actions. Edit profile is `main.ds-page.mid.pe` with the same hero as its live preview.
- **One section-heading style on both pages: the pixel heading** (12px Press Start, gold, `.ds-pixel-h` values). The story strip's heading already uses it, so the profile's card headings (GTF, Badges, Analytics, Plex) and every Edit profile card heading follow it.
- **Stat strip** (`.pf-strip > .ps`): cells on `--ds-sunken`, divided by 1px `--ds-line` gaps, radius 12. Label 11px/700 uppercase muted, value 18px/700 tabular (16 on phones), PAT in `--ds-gold-text`, the XP bar 6px `--ds-green` (the lime end of the old gradient is gone).
- **Profile buttons** (`.pf .btn`, `.gtf-pop .btn`) are `.ds-btn.sm`-sized pills: 36px (40 on touch), 13.5px/700, a transparent fill with a `--ds-line-strong` border; `.primary` is the accent fill with dark ink. Icons go in `.ds-ic`. The unread tip counter on More is the `.ds-badge` look.
- **Tabs** (`.pf-tab`, role=tab): `.ds-tab` pills, 40px, the current one is the accent tint. The old underline tabs are gone.
- **Role chips** (Admin, Staff, Season Pass, Plex, GTF): 24px sentence-case pills, 12px/700, like `.ds-tag`.
- **The ⋯ More menu** is a `.ds-pop` (surface-3, radius 12, `--ds-e-3`) with 40px `.ds-menu-item`-style rows. The GTF popover uses the `.ds-modal` surface, radius and shadow.
- **Badges grid:** `minmax(min(100%, 104px), 1fr)`, forced to 3 columns at ≤ 520 so phones don't get a 2-column wall of tiles.
- **Analytics tables** sit in an `overflow-x: auto` box (`.ua-tw`), so a long room name or action scrolls inside the card, never the page.
- **Edit profile fields** follow the `.ds-in` spec in page CSS (44px, radius 10, sunken, accent halo, 16px under 760) because they keep their legacy markup. A button next to a field is 44px, so the field and its button line up. Toolbar buttons (top actions, hero, layout actions) are 36px. The password row's button is 44px and bottom-aligned with the two fields.
- **Edit profile jump links** are `.ds-tab`-style pills (36px, 40 on touch).
- **Connections rows:** a sunken well, radius 12, padding 12/14, a 36px brand tile, then the name, then the action. On phones the action goes full width under the name. Brand buttons are pills; Telegram uses #1a7bb0 for white ink (see the auth notes).

---

## Area notes: stage, media and shop

Added by the G5 polish pass (shop, storefront, item, My orders, an order, seller dashboard; Go live, stage captures; Plex hub, Manage requests, Requests).

### Shop (/shop, /shop/item/:id, /shop/seller/:u, /shop/orders, /shop/orders/:id, /shop/seller)

- **Accent.** The shop's area accent *is* the loot gold (§2.5): `.sh` sets `--ds-ac: var(--ds-gold)`, `--ds-ac-2: var(--ds-gold-text)`, `--ds-ac-bg: rgba(255,207,64,.12)`, `--ds-ac-line: var(--ds-gold-line)`, `--ds-on-ac: var(--ds-on-gold)`. So focus halos, current pills and hovers are gold. Links stay green (`--ds-green-2`), and the **Buy / Apply / Mark fulfilled** buttons stay green with dark ink (`--sh-on-green`, #04150a), because green means "act" and gold means "spend". Gold buttons (`.btn.gold`, `.qbtn.gold`) are the PAT actions: search, See it, Buy for N PAT, List it.
- **Wrappers.** Storefront pages: `main.ds-page.wide.flow.sh.st` (block flow, the sections keep their own rhythm). Dashboards: `main.ds-page.sh.sd` (the 24px grid gap); a single order is `.ds-page.mid`. `/shop/admin` and `/shop/edit` still use the legacy `.sh` box (`.sh:not(.ds-page)` keeps its old max-width and padding) and get the token colours, field reset and dark-ink buttons only.
- **One heading style:** every shop section heading is the pixel heading (12px gold Press Start, `.ds-pixel-h` values). The shop is an arcade-flavoured area, so it never mixes in `.ds-h2`.
- **Heroes.** The storefront hero and the dashboard hero (`.st-hero`, `.sd-hero`) follow `.ds-hero.gold`: radius 18, padding 24/20/20 then 32/32/28 at ≥ 700, the #2a2208 gold glow (a seller's storefront swaps it for the #10261a green glow; a gift order for #2a0f24 pink). The h1 is the display size with one gradient `em`. The wallet box in the hero is a `--ds-glass` well with a `--ds-gold-line` border, radius 12.
- **Hero search** is a 44px pill input with a 44px gold pill button. The redemption-code form uses the same 44px pair.
- **Shelf chips** (`.st-chips`) keep the 1.99mv scroller (edge fades, arrows on fine pointers, drag) but take the `.ds-tab` metrics: 36px pills (40 on touch), 14px/500, #151515 fill, #2a2a2a border. The current shelf is a **solid gold** pill with `--ds-on-gold` ink (the shop's look, instead of `.ds-tab`'s tint); "✓ I can afford" is the green variant. The arrows are 36px circles on `--ds-surface-3`, `inset-inline`, mirrored in RTL.
- **Item card** (`.st-card`): `--ds-surface`, 16 radius, 4:3 picture, body padding 12/12/14, title 15px clamped to 2 lines, price 18px gold-text with the unit at .7em #d9c88a, actions 40px pills. Hover lifts 1px with `--ds-e-2`. At ≤ 420 the grid is 2 columns and the Buy / View pair stacks full-width.
- **Order card** (`.sd-order`): card padding 16, a 112px picture column (76 at ≤ 600), title `.ds-h3` size, a status chip (`.sd-badge`, 11px/700 uppercase, the dot, colour from the server's status colour through `--c`), the stepper, then the actions. The `.sd-subnav` bar is `.ds-subnav` with the gold current pill; the unread count inside it is a `--ds-badge` pill.
- **Quick-link buttons** (`.qbtn`) are 44px ghost pills with a leading `.ds-ic`; `.qbtn.gold` is the filled one. In an empty state they drop to 36px.
- **Empty states** (`.st-empty`, `.sd-empty`) are the `.ds-empty` recipe (dashed #333, radius 16, 30px emoji, 15px title). The "no such seller / item / order" pages use the same box with an h1 at card-title size.
- **Tables** (seller listings): `.sd-tbl` is the `.ds-tbl` box (surface, 16 radius, #151515 head, 11.5px uppercase th); row actions are 36px pills. Below 760 the table becomes a card list (`data-l` labels).
- **Status text** written by the page JS (buy / redeem results) uses `var(--ds-ok)` and `var(--ds-danger-solid)`, and `scrollIntoView` is instant under reduced motion.

---

## Area notes: money and markets

Added by the 1.99pp polish pass (markets, a market, wagers and pools, polls, bounties, a bounty; later passes add the wallet, staking, history, economy, tips, cosmetics and the support pages).

### bets.css is a skin over ds.css

- `public/css/bets.css` keeps its `bx-*` class names, because page JS (`public/js/bets.js`) and test/bets-design.test.js use them, but every value is a ds token. Each `bx-*` class renders exactly like its ds twin:

| bets.css | ds.css twin |
|---|---|
| `.bx-hero`, `.bx-eyebrow`, `.bx-lead`, `.bx-ctas`, `.bx-stats` > `.bx-stat` | `.ds-hero`, `.ds-eyebrow.ac`, `.ds-lead`, `.ds-ctas`, `.ds-pills` > `.ds-pill-stat` |
| `.bx-h` (+ `.bx-n`, `.bx-hr`) | `.ds-h2.dot` (+ `.ds-count`, `.ds-h-aside`) |
| `.bx-card`, `.bx-ref`, `.bx-meta`, `.bx-big` | `.ds-card`, `.ds-ref`, `.ds-meta`, `.ds-pat.lg` |
| `.bx-chip.c-*` | `.ds-chip.*` (the §6.2 vocabulary: c-open/live → ok, c-closed/waiting/settling/accepting → warn, c-settled/won/resolved → gold, c-void/expired/… → mute, c-disputed/late → danger, c-proposed/ai → info, c-offer → solid gold) |
| `.bx-btn` (`.ghost`, `.gold`, `.amber`, `.danger`, `.blue`, `.sm`, `.wide`) | `.ds-btn` (`.ghost`, `.gold`, `.warn`, `.danger`, `.info`, `.sm`, `.wide`) |
| `.bx-form`, `.bx-field`, `.bx-in`, `.bx-check`, `.bx-qa`, `.bx-row2` | `.ds-form`, `.ds-field`, `.ds-in`, `.ds-check`, `.ds-quick`, `.ds-form-row` |
| `.bx-note`, `.bx-ok`, `.bx-empty` | `.ds-note.warn`, `.ds-note.ok`, `.ds-empty` |
| `.bx-bar`, `.bx-tbl` | `.ds-bar`, `.ds-tbl` |

- New bets-style pages should use the ds classes directly; the `bx-*` names exist for the six pages above.
- **Wrapper:** `<main class="bx ds-page flow ‹area›">` (`mid` for polls and a bounty). `.ds-page` gives the width, gutter, type, link colour and gold focus ring; `flow` keeps the block layout, because these pages space their sections with the `.bx-h` margins (32 above, 12 below) rather than the page grid gap.
- **Accent:** the page sets the ds names on its wrapper (`--ds-ac`, `--ds-ac-2`, `--ds-ac-bg`, `--ds-ac-line`, `--ds-on-ac`). `.bx` derives the old `--ac`, `--ac2`, `--acbg`, `--acink`, `--gold`, `--goldt`, `--card`, `--line`, `--mut` … from the tokens, so older page CSS that still reads them follows. Setting `--ac` alone no longer recolours the components.
- **Buttons on the markets green now use dark ink** (`--ds-on-ac`, 6.8:1). They were white on #4caf50 (2.8:1), including the market page's own `form button[type=submit]`, which is now a `.ds-btn` twin. The Sell button in the position table is `danger` (it was a one-off #b85c38 orange).
- The gold button is the 90° `--ds-gold-grad` (it was the 180° #ffe57f→#ffc400 variant, §12) and is the only button that lifts on hover.

### Patterns settled here

- **Icons in eyebrows and chips:** `.bx-eyebrow` is a flex row, so its leading `.ds-ic` (14px glyph in a 16px box) centres on the pixel text. A chip's icon is `.ds-ic` at 12/14. Emoji that are built inside an EJS expression (a table cell like "🏆 winner", an order status "✅ / ❌ / ⏳") are emitted as the `.ds-ic` span string inside `<%- %>`, never as a bare emoji in `<%= %>`.
- **Detail-page stat tiles (market header):** three tiles in one row on desktop; at ≤ 420 they become two columns with the first (the volume, the longest number) spanning the row, and the numbers never wrap (`white-space: nowrap`). Never let `overflow-wrap: anywhere` split a number.
- **Poll options on phones:** a vote row is a 2-column grid (text, then the tally and the vote pill). At ≤ 420 it stacks to one column with the tally under the text, so long options don't wrap one word per line.
- **Option colours** (Yes green #4caf50, No red #e57373, then blue, gold, purple, cyan, orange, lime) are chart colours and stay hex; a settled winner's bar is `--ds-gold`, a voided option's bar `--ds-text-disabled`.
- **Sticky side card** (the market's trade panel at ≥ 900): `top: calc(var(--ds-nav-h) + var(--ds-sp-3))`, never a hard-coded 76px.

### Money pages: wallet, staking, history, economy (1.99pr)

- **Recipe:** `.ds-hero.gold` (eyebrow, h1, lead) on all four. The wallet's balance is the page's one `.ds-pat.xl` (the gold-gradient number); its mini stats are `.ds-stats` in 3 fixed columns. Quick actions are `.ds-btn.sm` (gold for Send, ghost for the rest). Wrappers: wallet `.ds-page`, staking `.ds-page.flow`, history `.ds-page.mid`, economy `.ds-page.flow`.
- **Pixel or Ubuntu section headings (§6.6):** when a page's heading strings are uppercase in the locale files ("MY STASHES", "STAKING"), use `.ds-pixel-h` for that page's sections (wallet, staking, history day cards). Ubuntu `.ds-h2` is for sentence-case strings (economy). Never re-case translated strings with CSS.
- **Sticky in-page nav:** the wallet's section links and history's period/category filters are `.ds-subnav` > `.ds-tabs` > `.ds-tab`; the current filter is the accent tab (`.on`), not a gold fill.
- **Tables with a long text column (§6.8):** give the long-text cell a minimum width (wallet's market positions: `td.q { min-width: 200px; max-width: 320px }`) and keep number cells `nowrap`. The table then scrolls inside its `.ds-tbl` on phones instead of crushing the question to one word per line.
- **Radio-driven tabs (CSS-only switches, staking's 7/30-day chart):** hide the radios with `.ds-sr-only`, never `display: none`, so they stay keyboard-reachable, and show focus on the label: `#id:focus-visible ~ .tabs label[for=id] { box-shadow: var(--ds-focus-ring) }`.
- **Pages that keep their own field and button markup (§6.7):** style them to match in page CSS: 44px fields, radius 10, `--ds-sunken`, a `--ds-line-strong` border, `margin: 0` (undoes the legacy rule), 16px at ≤ 760; buttons are 44px pills with `--ds-on-ac` ink on green and `--ds-on-gold` on the gold gradient, 36px inside inline forms and table cells. Spending PAT (Stake, Send) is the gold button; reversing it (Unstake) is `quiet`.
- **Long explainer pages (economy):** `.ds-page.flow`, because a sticky contents bar can't stick inside a grid cell. Space top-level blocks with `> * + * { margin-block-start: var(--ds-sp-6) }` and `--ds-sp-12` before a new part. The contents bar is a `ul.ds-tabs` of `.ds-tab` links: it scrolls sideways on phones and, at ≥ 900, wraps and sticks at `top: var(--ds-sp-2)` with blur and `--ds-e-3`. Sections get `scroll-margin-top: 90px`. Each section is a `.ds-eyebrow.ac` kicker, then a `.ds-h2` with a `.ds-ic` emoji, then a lead. Diagram panels are sunken figures (radius 16); tiles inside a card are sunken, radius 12, with a 3px `border-block-start` in their own colour (`--c`). A chart or gauge forces `direction: ltr`.
- **Known gap:** economy's large explainer SVGs scale to fit at 375, so their text renders around 8px; they need a phone-specific drawing.

---

## Area notes: home, info, legal and admin

Added by the G6 polish pass (1.99pq onwards): the homepage, /about, /info, /help, /terms, /privacy, /guidelines, /friendo, the admin shell and every staff page. All of them keep the PATV green accent.

### Legal and long-text pages (terms, privacy, guidelines)

- `main.lg.ds-page.read.flow` with the shared `partials/legal-css`: the read width (760), block flow, so the sections keep the prose rhythm (32 between sections, .85em between paragraphs).
- The hero is the ds hero recipe on a `<header class="hero">`, with `box-shadow: none !important` and an explicit text colour to cancel styles.css's global `header` rule (see the gotcha above).
- **Status pills in the hero:** "Last updated" is an ok-tinted pill (13px/700); a draft notice is a `--ds-gold-bg` note, radius 12, with a solid amber `DRAFT` chip.
- **Contents box:** a ds card (surface, 16 radius, 16 padding), a 12px uppercase muted label, two CSS columns from 761px and one below. Set `margin: 0` on the `li`s: a top margin on the first item only applies in the first column, so the columns start 4px apart.
- Section `h2` is 20px/700 with a 1px `--ds-line` rule under it; `h3` is 17px; both have `scroll-margin-top: nav height + 12` for the TOC anchors.
- **Data tables** (the privacy retention table) scroll inside a `.tw` box (surface, line, radius 16) at ≥ 761px and turn into one card per row below that; th is the `.ds-tbl` head style.
- **Placeholders** (`.ph`, `[[FILL ME IN]]`) are a danger-tinted dashed mono chip, so an unfilled value can't pass for real text.
- **Rule list** (guidelines' hard limits): rows with a 4px inline-start severity rule (danger / warn-fill / green) and an end-floated severity chip in the same colour, so the colour never carries the meaning alone.
- The legal text itself is never touched by a polish pass; only the wrappers and classes change.

### Help (/help)

- `main.hlp.ds-page.wide.flow` at 1120px. The hero and the sticky filter bar are one unit: the hero has its top radii (18), the bar its bottom radii, and a shared border.
- Filter controls are 44px (search field with an inset 🔍 at `inset-inline-start: 14px`, role select); the category chips are `.ds-tab`-sized pills (36, 40 on touch) that scroll in one row on phones.
- The "Ask" box is a gold card (`.ds-card.gold` recipe) with a 44px gold pill submit.
- Command cards are ds cards with the role colour as the 3px top rule. Role / price / gate badges use the `.ds-tag` shape with the semantic tints (everyone and web = ok, mod = info, admin = danger, gate = warn, price = gold).
- The copy button is a 36px quiet pill (40 on touch); the `#` permalink is a 32px icon target in muted text.

### Old content pages (info)

- `.ds-page.read`, a `div.ds-head`, then one `.ds-card.lg` per block; flash messages become `.ds-note.danger` / `.ds-note.ok`.
- **Brand-logo links** (Twitch, Discord, Plex, Jellyfin as images): a 32px pill (`--ds-sunken`, `--ds-line-strong` border, accent on hover) holding a 16px-tall `.ds-ic` image with `alt=""`, and an `aria-label` with the service name on the link.
- Command lists are a plain `ul` of `code` + description rows, gap 6.

### Standalone pages (friendo)

A page without layout.ejs still loads `ds.css` (for the tokens), sets the viewport meta and `theme-color`, and paints `body` with `--ds-bg`. Its own CSS sizes everything relative to a `min(800px, 100%)` box, and its motion is off under `prefers-reduced-motion`.

---

## Area notes: games (lotto, GTF, achievements, rankings, wheel)

Added by the 1.99ps polish pass (G2). Game pages keep their own illustration (balls, felt, minimap, marquee) but sit on `.ds-page` and read the tokens for everything else.

### Arcade and area pages: the shared rules

- **Wrapper:** `main.ds-page` (`.wide` for GTF and achievements), plus the page's own class that re-points the accent once: `--ds-ac`, `--ds-ac-2`, `--ds-ac-bg`, `--ds-ac-line` and `--ds-on-ac`. Private colour variables (`--gold`, `--lav`, `--neon`…) are kept only as aliases of tokens or of illustration colours, so the existing selectors don't change.
- **Section heading style per page:** lotto uses the Ubuntu 20px `.ds-h2` size with the lotto's gold-ball dot (`.pb-h`). GTF, achievements, rankings and the wheel use `.ds-pixel-h` (achievements tints it neon with a glow; the wheel's boards keep their own 12px gold pixel h2). Card titles inside a grid (GTF's four parts, Pepeball's "Pick your numbers") are card-title size (17px), not section headings.
- **Area hero:** an area may keep its own hero background (lotto purple, GTF red/green with the hazard stripe, achievements' scanline marquee). It still uses the ds radius (18), the hero padding (32 at ≥ 700, 24/20 on phones), `.ds-eyebrow`, the display h1 and `.ds-lead`.
- **Pixel h1 exception:** none. Achievements' h1 moved from Press Start to the display style (gold, with its glow), and the rankings h1 moved to the compact hero. The **one** exception is the gold wheel's neon "JACKPOT" sign, which is the cabinet marquee art rather than a page title, and is left as it is.
- **Pixel text floor:** Press Start is never below 9px. Badge tiers, minimap labels and chips, and wheel table heads moved from 7/8/8.5px up to 9px.
- **Game buttons:** a game's big gold CTA (`.pb-btn`) is the ds gold button (`--ds-gold-grad`, `--ds-on-gold` ink) at 48px with the gold focus ring. Small game pills (`.pb-chip`, the achievements filters) are 36px (40px on touch, ≥ 40 when they are the main control) and take `--ds-focus-ring`. Lotto number balls are buttons with the 2px gold outline.
- **Legacy input reset:** a game's own number field (Pepeball's ticket count) is written as `input[type="number"]` in the page CSS, so it beats the global styles.css rule, and it resets `margin`, `width`, `color` and `border`.
- **Tables:** game tables keep their skin (lotto purple heads, wheel prize table), but sit in a scroll box with radius 16, 11.5px uppercase heads, `text-align: start/end` and tabular numbers.
- **Motion:** every looping effect (floating balls, shimmer, radar sweep, bulbs, flicker, blink) is either gated behind `(prefers-reduced-motion: no-preference)` or killed in a `reduce` block. Blinks stay at or below 3 Hz.
- **`::backdrop`** doesn't inherit custom properties in older engines, so a `<dialog>` backdrop writes `var(--ds-scrim, rgba(0,0,0,.62))` with the fallback.

### Pepeball (/lotto, /lotto/fair/:draw)

- `main.ds-page.pbx` with the lotto accent (`--ds-acc-lotto` / `--ds-acc-lotto-2`, white ink on the purple fill). Illustration colours stay local: the purple field `--pu0..2`, lavender text `--lav`/`--lav2`/`--mut`, and the ball gradients.
- Purple cards (`.pb-card`) are radius 16 and padding 16 on every width. Inner wells (tray, tickets, tiers, top winners) are radius 12 or 10.
- Notes and totals use the gold note tokens (`--ds-gold-bg`, `--ds-gold-line`, `--ds-warn-ink`). Errors use `--ds-danger`.
- The fairness page is a detail page: `.ds-page.mid`, `.ds-back`, a `.ds-head` (eyebrow "Pepeball" in the lotto accent, `.ds-h1`), then `.ds-card`s. The script fills `#lf-rec` (now `aria-live`).
- Test hooks to keep: `.pb-jpn[data-count]`, `.pb-tier.jp`, `form.pb-card.pb-pick#pb-pick`, `.pb-n` buttons, `.pb-qp`, `.pb-b` ball markup, `.pb-tk.won/.lost`, `.pb-b.lg[style=--i]`.

### Grand Theft Frogger (/gtf)

- `main.ds-page.wide.gtf`, accent `--ds-acc-gtf` with the part colours (`--ds-acc-gtf-2`, `-violet`, `-red`) as each part card's 3px top rule.
- Hero CTAs are `.ds-btn.gold` (how heists work) and `.ds-btn.ghost` (bounty board, turf map). The "your character" panel inside the hero uses a `.ds-label` heading and `.ds-btn.sm`.
- Part-card link rows are 40px tall with a `›` chevron that flips in RTL.
- The heist minimap keeps its city grid, sprites and LED colours. It is drawn by the page script, so its classes (`.lot`, `.chip`, `.cd`, `.bar`, `#mmCity`, `#mmRadar`, `#mmLive`, `#mmPips`, `[data-ready]`) are hooks.

### Achievements (/achievements)

- The arcade look stays: scanline marquee hero with an inset ring, neon pixel group heads with a dashed rule, pixel badge names, rarity-coloured frames. Borders are 1px; the badge frame keeps its 2px rarity ring as illustration.
- Rarity colours are the `--ds-r-*` tokens. The XP chip stays cyan and the PAT chip is gold-text on a gold line.
- The filter bar is a sunken panel (radius 12), sticky from 1000px. The search field is `.ds-in`. "No matches" is a `.ds-empty` with a `.ds-btn.ghost.sm` reset. The ✓ / 🔒 in the state filter are `.ds-ic`.
- On phones the rarity tiles wrap the label and the count instead of breaking the word.

### Rankings (/rankings)

- `main.ds-page.lb` with a gold accent. The header is `.ds-hero.compact.gold` (h1 at page-title size), with the supply / burned / jackpot tiles as glass tiles (min 44px, gold-text values, focus ring).
- The board switcher is `.ds-tabs` > `.ds-tab` with `role="tab"` / `aria-selected`. The `.lb-tab` class stays, because the script finds the tabs by it. The selected tab is the gold accent tint, not white on green.
- Rows are at least 44px tall. The "You" tag is dark ink on green. Panel headings are `.ds-pixel-h`.

### Gold wheel (/u/:u/wheel)

- `main.ds-page.flow.aw` (block flow; the cabinet manages its own spacing). `arcade-wheel.css` keeps its VT323 + Press Start cabinet, and is also used by the home page's compact coin-op (`.aw.aw-hm`), so it is shared.
- Its gold is `--ds-gold`, its muted text is `--ds-text-muted`, zero-prize rows use `--ds-text-faint` (#6f6f7d failed AA), focus is the gold 2px ring, and the tool buttons are 44px.
- Breakpoints collapsed onto the ds set: 1000 (the stage stacks), 600, 420.
