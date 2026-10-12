# docs/

Everything about how PATV looks, sounds and works, in one place. The look-and-voice docs are also rendered live at
**`/styleguide`** (unlisted, noindex): Brand, Design system, Pepe and Writing tabs.

## Brand and design

| Doc | What it covers | Live |
|---|---|---|
| [brand.md](brand.md) | The brand guide: mission, audience, values, personality, voice and tone, house words, emoji, localisation, visual identity, community and safety stance, **Pepe's character bible**, writing checklists | `/styleguide/brand`, `/styleguide/pepe`, `/styleguide/writing` |
| [design-system.md](design-system.md) | The design system: tokens, type, spacing, components, icons, motion, accessibility, page recipes, area polish notes | `/styleguide/design` (values read live from `public/css/ds.css`) |
| `../locales/README.md` | How site strings and translations work | `/translate` |
| `../locales/glossary.json` | House words translators keep (PAT, pad, Fort Knox, Pepeball…) and per-language style | |

Pepe's character bible is brand.md §5.

## Pads

| Doc | What it covers |
|---|---|
| [pads-ownership-connections.md](pads-ownership-connections.md) | Who owns a pad (the creator or an admin's pick, never a connection), connections to Camfrog / Twitch / Discord / IRC, and how 💎 Prime Time Plus gates them (5 spots, Pepe joins / leaves) |

## Backends and runbooks

| Doc | What it covers |
|---|---|
| [backend-migration-audit.md](backend-migration-audit.md) | Moving game backends from Pepe to the site |
| [casino-backend.md](casino-backend.md) | Blackjack and Hold'em on the site |
| [gtf-backend.md](gtf-backend.md) | Grand Theft Frogger backend |
| [lotto-backend.md](lotto-backend.md) | Pepeball backend |
| [escrow-cutover-runbook.md](escrow-cutover-runbook.md), [gangs-cutover-runbook.md](gangs-cutover-runbook.md), [lotto-cutover-runbook.md](lotto-cutover-runbook.md), [pools-cutover-runbook.md](pools-cutover-runbook.md) | Cutover runbooks |

Deploying is in `../deploy/README.md`.
