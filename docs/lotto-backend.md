# Pepeball (the lotto) on the backend

Site 1.99ml (`lotto/engine.js`, `lotto/service.js`, `lotto/routes.js`) + bot 1.99mm (`pepe_lotto.py` client).
Approved by the user on 2026-10-11: "move the lotto backend to PATV so it doesn't have to 'send to Pepe'".
It follows the casino backend pattern (`docs/casino-backend.md`): the site owns the state and the money, and Pepe is a thin client.
The cutover runbook is `docs/lotto-cutover-runbook.md`, and the wider audit is `docs/backend-migration-audit.md`.

## What moved

| | Before (Pepe) | Now (site) |
|---|---|---|
| Tickets | `lotto.json` tickets plus escrow holds `T<draw>` | `lotto_tickets` (one row per ticket) and `lotto_purchases` (one per purchase, keyed) |
| Jackpot pot | Pepe's local vault `lotto` in `turf_data.json` | `lotto_pot`, a keyed movement ledger whose balance is `SUM(amount)` |
| House (60%) | Pepe → `/api/g/heist/jackpot-adjust` | `jackpot_rakes` rows, spinId `lotto:T<draw>` (`jackpotflows.js` reports them as "lotto") |
| Draw and schedule | Pepe's heartbeat, `SystemRandom` | a site tick every 5 s; commit/reveal with the tickets digest |
| Payouts | escrow grants from the House and the pot | `ledger.post` keyed per player and tier |
| XP and website notice | Pepe `_grant_xp` and `notify_user` | the site: `updateLevel` (same 0.005 XP/PAT) and `inbox` (ref `lotto:<draw>:<uid>`) |
| `/lotto` page state | `lotto_state`, a mirror pushed by Pepe | `lotto_state`, written by the service (`storeSnapshot`); Pepe's `/api/lotto/sync` gets a 409 |
| Web purchase | the `/act` queue → Pepe runs `!lotto` | `/act` with `cmd=lotto` buys directly (`buyFromForm`), and `POST /api/lotto/buy` takes JSON |

**What stays in Pepe** (Camfrog-specific, or pools that haven't moved yet):

- **Room commands.** `!lotto`, `!lottery`, `quick`, picks, `tickets`, `results`, `odds`, and admin `draw`, `test` and `replay`.
- **Announcements.** The sales milestones (every 1,000 tickets), the "last call" an hour before sales close, and the draw result with its fairness link.
- **The OBS overlay.** The ball reveal.
- **Camfrog-linked winners.** For these: gang rep, the `lotto_tickets`, `lotto_wins` and `lotto_jackpots` achievements, and the cosmetic drop rolls.
- **The reseed after a jackpot hit.** The sources are still Pepe's pools: the House surplus and the incentive budget (`_v2_lotto_reseed`), or the Reserve on v1. The site lists the reseed as due in the poll. Pepe moves the PAT into the site's pot with keyed legs, then acks through `/api/lotto/bot/reseeded`. If Pepe is down, the pot waits at 0 plus new sales until he's back.

## Economy: unchanged

- **Rules.** PAT 1,000 a ticket. Pick 4 of 1-30 plus a Pepe Ball from 1-10. The draw is Sunday 21:00 America/New_York, and sales close 300 s before it. Up to 500 tickets per purchase.
- **Price and pot share.** Both are Pepe's admin settings (`price_lotto_ticket`, `lotto_pot_share`). The cutover carries the live values into `lotto_settings`.
- **Split.** 40% of every ticket goes to the pot and 60% to the House. The cutover refuses unless Pepe's `lotto_tickets` route is 100% House, which is its default.
- **Prize table.** Unchanged (`engine.PRIZES`), with the same per-ticket `int(prize × scale)` and the same jackpot split per winning ticket. The jackpot is capped at 100M.
- **Fixed prizes.** Paid by the House. When a payout would take the House below its hard floor, the Fed's flash liquidity covers it first (a `flash:house:lotto` claim, the same mechanism as `_mo_house_cover`). If the House still can't cover the prizes, they are scaled down pro rata. The House never goes negative.
- **Jackpot.** Paid by the pot. After a hit, Pepe reseeds 1M.

## Fairness (new)

Pepe's draw used `SystemRandom` with no proof. The backend uses commit/reveal, with the players' tickets as the client seed.

1. **When sales open.** `commitment = sha256(server_seed)` is published (on `/lotto` and `/lotto/fair/<draw>`).
2. **When sales close.** The site publishes `tickets_digest = sha256` over every ticket line, `"<id>:<w1>,<w2>,<w3>,<w4>:<pb>\n"` in id order. The full list is published at `/api/lotto/fair/<draw>`, without owners. Nobody, the site included, knows the digest while tickets can still be bought, so the operator can't buy into a known result.
3. **The numbers.** They come from the casino byte stream: `HMAC-SHA256(server_seed, "<digest>:<draw>:<counter>")`, read as big-endian 32-bit words with rejection sampling. A partial Fisher-Yates over 1..30 picks the four numbers (sorted), then the Pepe Ball is `1 + below(10)`.
4. **After the draw.** The seed is revealed. `/lotto/fair/<draw>` re-checks all three steps in the browser with WebCrypto.

The draw imported at the cutover gets a fresh commitment at import time. It is published before that draw's sales close, so its digest still covers every ticket, the imported ones included.

## Money and crash safety

Every movement has a deterministic key and is looked up before it is made:

- **A purchase.** The charge is `transactions` row `lt:<web|cf>-…`. The pot gets `<key>:pot` and the House gets `<key>:house`. The purchase row is written as `charging` before the charge.
  - Boot recovery finishes the purchase if its draw is still selling.
  - Otherwise it refunds it (`<key>:refund`, type `lotto-late-refund`).
  - A purchase that was never charged is marked `failed`.
- **A draw.** The numbers and the whole prize plan are saved before any money moves. `pay()` resumes from the saved `progress`:
  - the House debit `lotto:T<d>:fixed`, after the flash cover;
  - the pot debit `lotto:T<d>:jp`;
  - the credits `lotto:T<d>:win:<uid>:<reason>`.
  
  A prize for an account that no longer exists goes back to the House or the pot (keyed). XP and the notice are marked before they are sent, so they are never sent twice.
- **Pepe's moves of the pot** (`!donate lotto`, Fed grants, the reseed) use `bot:<ref>`, where the ref is his vault-leg key. The pot never goes negative.
- **Concurrency.** One mutex covers every mutation, and a tick every 5 s closes sales, draws and pays.

## Pepe as a client

- **The switch.** Per instance, in `lotto_client.json` `{on, cursor, cutover}`. It is gitignored, and only the cutover writes it.
- **Commands.** These run on the pepe-cmdnet worker and call `/api/lotto/bot/act` with an idem key. The reply wording is unchanged.
- **The `lotto-poll` thread.** It long-polls `/api/lotto/bot/poll` (a 7 s wait; the cursor is saved).
  - Stale events are not announced: draw results older than 30 min, and milestones or last calls older than 10 min.
  - Paid winners are handled once per draw.
- **The `lotto` vault.** While the client is on, Pepe's `lotto` vault is the site's pot:
  - `_vault_total` reads it, with a 10 s cache;
  - `_vault_adjust` and `_vault_leg` post keyed refs.
  
  So `!donate lotto`, `!econ fund lotto` and the reseed work unchanged.
- **Supply.** `/api/stats/supply` counts the site's pot as `vault:lotto` and drops Pepe's stale row once the pot table has rows.
- **Safety net.** While the site's switch is on, an old Pepe that still runs his own lotto gets a 409 on `/api/lotto/sync`. He then pauses his local sales and draws.

## Not done / follow-ups

- **Web-only winners** (no Camfrog link) get the payout, XP and the website notice, but no Pepe-side achievements, gang rep or drops. Those still key on Camfrog names; see audit phase 5.
- **Pepe's vault ledger** (`pepe_vaultlog`) no longer sees ticket and prize flows. The House side is in `jackpotflows.js` under "lotto"; pot moves Pepe makes are still logged.
- **Pepe's admin settings** for `price_lotto_ticket` and `lotto_pot_share` no longer affect the backend. Change them on the site: `node tools/lotto-admin.js price=…`.
