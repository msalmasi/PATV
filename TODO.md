# PATV / PepeFrog — TODO & Tech Debt

Running list of future changes and known issues. Newest items at the top.

---

## Security

### Move wheel spin result determination server-side
**Priority:** Medium · **Area:** PATV backend (`index.js`)

The wheel spin outcome is currently computed **client-side**. The browser runs the
angle/segment math, decides the result (including JACKPOT), and POSTs it to
`/api/g/wheel/spin/result` (around line 3051 in `index.js`), which **trusts** the
reported result and pays out accordingly.

This means a technically sophisticated user could forge a `JACKPOT` (or any high-value)
result by POSTing a crafted payload, bypassing the intended odds.

**Intended jackpot odds** (from wheel config in `public/publicwheel.js` / `public/script.js`):
- JACKPOT segment weight `0.05` out of total weight `23.35` → **0.2141%** per spin (~1 in 467).
- Observed rate over 30 days (as of 2026-06-20): 22 jackpots / 9,360 paid spins = ~1 in 425,
  which matches the design — so no evidence of exploitation currently.

**Fix:** Generate the spin result on the server using the same weighted table, return the
result to the client for display only, and have the client animation land on the
server-decided segment. The `/spin/result` endpoints should stop trusting a
client-supplied `result`.

**Why deferred:** Not currently being abused; observed odds match design. Revisit when
there's time to refactor the spin flow without breaking the wheel animation UX.

**Partial mitigation already in place (2026-06-20):** The jackpot is now gated by a
secondary server-side roll (`JACKPOT_CONFIRM_CHANCE` in `index.js`), so even a forged
`JACKPOT` result only pays out ~9.3% of the time (overall ~1 in 5000). The regular-prize
amounts are still client-trusted, so the full server-authoritative refactor is still wanted.

### Jackpot odds config (for tuning)
Set in `index.js` near the `/api/g/wheel/spin/result` endpoint:
- `JACKPOT_TARGET_ODDS` (default 5000) — desired ~1 in N spins. Lower = more frequent.
- `JACKPOT_SLICE_ODDS` (467) — how often a spin lands on the visual jackpot slice
  (slice weight 0.05 / total 23.35). Update if the wheel segment weights change.
- `JACKPOT_CONSOLATION` — near-miss payout, currently 1x the largest wheel prize (60000).
  Keep `SPIN_MULTIPLIER` / `LARGEST_BASE_PRIZE` in sync with `public/publicwheel.js`
  and `public/script.js` if the wheel prizes change.
- `JACKPOT_MINIMUM` (100000) — the pot resets to this floor after a jackpot is won
  (instead of 0). Applied in both spin-result endpoints right after the pot is cleared.
  Kept above `JACKPOT_CONSOLATION` so a jackpot always beats a near miss.
Both spin-result endpoints (`/api/g/wheel/spin/result` and `/api/u/:username/wheel/spin/result`)
use these constants.

---
