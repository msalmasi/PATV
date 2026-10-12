# Backend migration audit: what runs on Pepe that belongs on PATV

Status: read-only audit, 2026-10-11. No code was changed for it.
Read from: site `origin/staging` 698ac19 (worktree `G:\wt\lotto-site`), bot `origin/staging` 7ffd408
(worktree `G:\wt\lotto-bot`), v2 docs `origin/v2:docs/v2/ARCHITECTURE.md` + `WORK-PACKAGES.md` (camfrog-bot repo).
Companion: `docs/casino-backend.md` (the pattern every move below reuses).

The request: "move the lotto backend to PATV so it doesn't have to 'send to Pepe'. Audit anything else that runs on
Pepe that can be moved to the backend, that probably should run there and not depend on Pepebot."

Where something could not be checked in the code, it says **unverified**.

---

## 1. Summary

**Main finding.** The lotto is one case of a larger pattern. Pepe's Windows VM holds most of the PAT economy that is
not a wallet, and the site only mirrors it:

- **Every protocol pool lives in one bot file.** `turf_data.json["vaults"]` holds the Federal Reserve, Fort Knox, the
  incentive budget, the Casino vault, Bank and MM cash, the lotto pot, the stakers pool, the bingo pot, the burn
  reserve and every `room:<id>` room vault. The same file holds the Fed's mint / grant / loan journals
  (`econ_layers`, `econ_monetary`, `econ_treasury`).
  - `_vault_adjust` (frida-bot.py:23942) rewrites that whole file synchronously on every movement (`_save_turf`,
    `json.dump(indent=2)`).
  - A failed save is only printed.
- **Player funds live there too.** Personal stashes (`pvaults.json`), staking shares (`vaults.json`), gang
  treasuries (`gang_data.json`) and turf stakes all sit in bot files.
- **The site holds only part of it.** It owns wallets (`users.points_balance` + `transactions`) and the House
  (`SUM(jackpot_rakes)`).

So the first real move is not one more game. It is moving the pools, the routing table and the economy settings onto
the site (Phase 1). After that, every game that moves next no longer has to "send to Pepe" for its money.

| # | Item | State today | Pepe down → | Recommendation | Effort | Risk | Phase |
|---|---|---|---|---|---|---|---|
| 1 | Blackjack | site `casino/*` (staging only) | works on web (staging) | **moved** (phase 1 of casino) | - | - | 0 (done on staging) |
| 2 | Lotto / Pepeball | bot `lotto.json` + pot in `turf_data.json` | no web sales, draw delayed | **moved** (site 1.99ml + bot 1.99mm, `docs/lotto-backend.md`; prod cutover: `docs/lotto-cutover-runbook.md`) | M | M | 0 (built, staging) |
| 3 | Hold'em | bot (`poker_engine.py`, `holdem_escrow.json`) | no web play | move (casino phase 2 - landed on staging during this audit, bot 1.99mf) | L | M | 0b |
| 4 | Pools + routing + econ config | bot `turf_data.json`, `bot_settings.json` | site claims unsettled; restart → legacy routing | **move** (foundation) | L | H | 1 |
| 5 | Funding claims (`reserve_claims`) | site pays, bot settles | claims pile up | **delete** (falls out of 4) | S after 4 | M | 1 |
| 6 | Charge + route (`_charge_pat` → `_route_pat`) | site debit, bot vault credit | n/a (bot-only path) | **move** (one keyed site call) | M | M | 1 |
| 7 | Cosmetics purchases from web | queued to Pepe | web purchases stall | **move** | S after 4 | L | 1 |
| 8 | Polls | bot `polls.json`, site mirror | web votes stall | **move** | S | L | 1 (parallel) |
| 9 | Wagers, parimutuel pools, bounties, P2P loans, donations (escrow) | bot `escrow.json` + per-feature JSON | no web actions, deadlines frozen | **move** (one site escrow service) | L | M | 2 |
| 10 | LMSR markets + MM vault | bot `markets.json`, `pepe_amm.py` | no trading, no settlement | **move** | M | M | 3 |
| 11 | Reserve (Fed) loans to players + Bank vault | bot `loans.json` + vault cash | no requests / collection | **move** | M | M | 3 |
| 12 | Staking (capital vaults) + stashes | bot `vaults.json`, `pvaults.json` | no stake/unstake; epochs late | **move** | L | H | 3 |
| 13 | Treasury epoch, monetary ticks, automint, burn, Casino-vault feed | bot ticks on the 30 s heartbeat | Monday epoch / 04:00 tick late | **move** (site scheduler) | M | H | 4 |
| 14 | Room vaults (E-3) + launchpad | bot `room:<id>` pools, `econ_launchpad` | site misroutes after restart | **move** | M | M | 4 |
| 15 | AI market judge | bot `pepe_aijudge.py` | no proposals | **split** (site settles; bot gathers evidence) - **built 1.99to** (`oracle.js`, `docs/oracle-contract.md`) | M | M | 5 |
| 16 | Achievements | bot counters, site awards | Camfrog counts pause (fine) | **split** - **built 1.99to** (`achprogress.js`, `docs/achievements-cutover-runbook.md`; staging ON) | M | L | 5 |
| 17 | Economy telemetry, supply snapshot | bot pushes | stale charts | **split** - **built 1.99to** (`supply.js`; Pepe sends only his rows) | S | L | 5 |
| 18 | Cosmetic drops | bot drop table + `/api/cosmetics/drop-config` | Camfrog drops pause | keep in bot (event side); config to site - **built 1.99to** | S | L | 5 |
| 19 | Raffles, top mic, trivia, pictionary, bingo, PvP | bot | games stop (expected) | **keep** (Camfrog-native); payouts via site pools | - | - | stays |
| 20 | Heists | bot `heist_data.json` | stop | **PINNED by the user: note only** | - | - | pinned |
| 21 | Turf / gangs | bot `turf_data.json`, `gang_data.json` | stop | keep with heists (engine is shared) | - | - | pinned |

---

## 2. How Pepe and the site are coupled today

There are five couplings. Each item in section 5 uses one or more of them.

**C1. The action queue: "Sent to Pepe".**
- What it is:
  - `actions.js` (table `pepe_actions`) stores a web form as `{kind, args}`.
  - Pepe claims rows (`POST /api/actions/claim`, bot token, 2-minute reclaim), runs each one as the user's linked
    Camfrog name through the real chat command (`pepe_webact.py`, `CMD_ALLOW = market pool wager bounty stash loan
    lotto cosmetic avatar donate`) and acks the reply (`/api/actions/ack`).
  - Other kinds: `poll.vote/create/end`, `notify`, `econ.burn`, `aigen`, `dj`, `room.*`, `stage.room`, `snap.save`,
    `camclip.save`, `micclip.save`, `stagecap.save`, `pepe.look`, `table`.
  - Two more queues work the same way: markets (`market_orders`, `/api/markets/orders/claim|ack`) and bounties
    (`bounty_actions`, `/api/bounties/actions/claim|ack`).
- Pepe down: forms show "Sent to Pepe", and the rows wait.
- **No age cutoff was found.** Neither `actions.js` nor `pepe_webact.py` has one (checked with grep). An action queued
  during an outage runs whenever Pepe comes back. That could be a market buy at a different price hours later, or a
  lotto buy after the draw closed. The lotto command's own checks should refuse the late lotto buy (**unverified**).
- It also needs a linked Camfrog name, because the user *is* that name in chat. Users without a link can't use any of
  it.

**C2. Snapshot mirrors (`/api/*/sync`).**
- Pepe pushes his state and the site keeps the latest copy for its pages:
  - `/api/lotto/sync` → `lotto_state`
  - `/api/markets/sync` → `markets`
  - `/api/wagers/sync` → `wagers`
  - `/api/bounties/sync` → `bounties`
  - `/api/staking/sync` → `staking_state`, `staking_daily`
  - `/api/polls/sync` → `polls`
  - `/api/g/roomvaults/sync`
  - `/api/wallet/stashes`, `/api/wallet/loans`
  - `/api/stats/supply` → `supply_snapshot`, `supply_history`
  - `/api/userstats/sync`, `/api/roomstats/sync`
  - `/api/tables/sync`
- Pepe down: the pages show stale data with no "as of" warning, except the admin "Reserve not synced for 30 min"
  alert in `adminweb.js`.

**C3. Funding sync + claims (the site pays, Pepe settles).**
- Pepe posts `/api/g/funding-sync` every 30 s heartbeat (`_funding_tick`, frida-bot.py:23701) with:
  - the Reserve balance
  - the `flows` map
  - the Fort Knox balance
  - the incentive budget
  - the `room_vaults` flag
  - the launchpad state
  - the `monetary` policy
  - the burn panel
- The site keeps all of it **in memory** (`funding.state`).
- When the site pays a reward funded by a Pepe pool, it writes a `reserve_claims` row: welcome, levelup, achievements,
  codes, Discord/Twitch rewards, boosts/slot-fee halves, staff grants, flash, donations. Pepe drains his pool and
  settles the row (`/api/g/reserve-claims`, `/settle`).

**C4. Money primitives that the site exposes to Pepe.** These are already site-owned and keyed. They are the
building blocks to keep:
- `/api/wager/charge` and `/api/wager/payout` (index.js:2004/2037)
- `/api/bonus/chatwinner` and `/api/g/heist/jackpot-adjust` (botcredits.js; source + ref required, logged in
  `bot_credit_log`)
- `ledger.post` (requireCover, `E_TARGET_NOT_FOUND`)

**C5. The pool store inside the bot.** `turf_data.json` (see section 1) plus `vaults.json`, `pvaults.json`,
`escrow.json`, `markets.json`, `loans.json`, `wagers.json`, `bounties.json`, `lotto.json`, `gang_data.json`,
`heist_data.json`, `achievements_progress.json`, `cosmetics.json` (bot copy), `polls.json`.

---

## 3. Fragile money paths found while auditing

These are the parts that are actually risky when Pepe is down, slow or restarting. They are the reason Phase 1 comes
before the other games.

**Fixed ahead of Phase 1 (site + bot 1.99ne, reliability only - amounts and destinations unchanged):**
- 3.1: `funding.js` saves every sync (`funding_state`) and restores it at start; the site listens only after that.
- 3.2: a paid command's charge carries its route; the site writes the debit and a route intent in one transaction
  (`patroutes.js`), Pepe applies it journaled under that key and acks it once saved (`pepe_routekeys.py`); un-acked
  intents are recovered exactly once. Covers `_charge_pat`, sponsor, sheet / avatar re-roll, heist gear and gang
  creation (the song queue and per-use voices still route un-keyed).
- 3.4: `_save_turf` serializes on the caller and writes on a background thread (`pepe_bgsave.TextSaver`), retried
  until it lands, flushed on every exit path.
- §2 C1 / Q3: queued web actions expire per kind (`actionttl.js`, admin-configurable); Pepe never starts one late.
- 5.11 (stashes only): stashes live on the site (`stashes.js`), Pepe is a client; the one-off hand-over runs on
  deploy (on by default on staging, an admin switch on prod).

1. **A site restart while Pepe is down silently switches the economy back to legacy routing.**
   - Why: `funding.state` is in memory. Until Pepe's first sync after a site restart, `fortknox`, `incentives`,
     `room_vaults`, `monetary` and `launchpad` are all `null`.
   - What happens in that window:
     - `boosts.routeInTx` books the Fort Knox half as a plain Reserve claim (`fortknoxLive()` false) instead of
       `fortknox:<flow>`.
     - The room half stays in the site escrow instead of a `room:<flow>:<id>` claim.
     - Flash liquidity is off.
     - The launchpad is off.
     - Incentive-routed grants queue.
     - Reserve-routed grants are refused, because `state.reserve === null` makes `fundable()` 0.
   - Nothing is lost, but money lands in the wrong pool. Deploys normally put the site first (patv-cicd), so this
     happens at every site deploy for up to 30 s, and for as long as Pepe is down.
2. **Charge and route are two stores with no journal between them.**
   - `_charge_pat` (frida-bot.py:6850) debits the wallet on the site (`/api/wager/charge`).
   - Then `_route_pat` (pepe_routes.py:344) credits the pools in `turf_data.json`.
   - A crash between the two, or a failed `_save_turf` (it only prints), loses the routed share. The PAT leaves the
     wallet but reaches no pool, which is an unrecorded burn.
   - `_route_apply` also swallows each leg's exception (`[ROUTES] ... failed`).
3. **A claim that Pepe can't cover is a de-facto mint until it is covered.**
   - The site credits the user first.
   - If the pool is short at settle time, `_funding_tick` leaves the claim unsettled ("left unsettled until it can
     cover it").
   - The site nets unsettled claims out of `fundable()`, which limits the damage. But the site's balance figure has
     **no TTL**, so after a long outage it can be hours stale.
4. **Pool writes are on Pepe's hot path.**
   - `_vault_adjust` → `_save_turf` dumps the whole turf file synchronously on every movement, including inside chat
     command handlers.
   - pepe-chat-lag showed that whole-file JSON saves on handlers were the cause of the reply bursts.
   - `_save_turf` has not been moved to `pepe_bgsave` (**verified** in frida-bot.py:26894: a direct `json.dump`).
5. **Scheduled economics depend on Pepe being up at the right moment.**
   - The Monday 04:00 UTC epoch (`_tr_tick`), the daily 04:00 `_mo_tick` (with a `BOOT_GRACE` after start), staking
     epochs (`_vaults_sweep`), the lotto draw (`_lotto_due`: `time >= next_at`, so it draws late after an outage)
     and loan auto-collect (`_loan_sweep`) all run on the 30 s heartbeat in `_sponsor_tick`.
   - Hourly automint does not catch up missed hours (by design).
   - A Pepe outage over Sunday 9 pm ET moves the draw. A long one shifts the weekly epoch.
6. **User funds outside the wallet ledger.** Stashes, staking shares, escrowed stakes, gang treasuries and turf
   stakes are not in `transactions` at all. Pepe pushes them to `/api/stats/supply` as aggregate pool rows. The v2
   genesis (L-6) has to snapshot every one of these files, and every pool moved to the site earlier shrinks that
   job.

---

## 4. The pattern every move reuses (from `docs/casino-backend.md`)

Blackjack phase 1 (site `casino/`, bot `pepe_casino.py`) set the template. Each item in section 5 should copy it
instead of inventing its own.

1. **The site owns the state and the money.**
   - The engine state is a JSON row per table or game (e.g. `casino_tables.state` with `rev`), saved after every
     change.
   - Secrets (seeds) stay in the row and never appear in a view.
   - Bots and web pages are both clients.
2. **Every PAT movement has a deterministic idempotency key.**
   - Format: `<game>:<id>:r<round>:<user>:<op>[:n]`.
   - Used as `transactions.transactionId` for a wallet move and `jackpot_rakes.jackpotId` for a House move. Before
     moving, look the key up; a retry finds it and skips.
   - For pools moved in Phase 1, the same key goes on a pool-movement row.
3. **A crash-safe intent journal.**
   - Write the intent into the state, then move money by key, then apply, then save.
   - Recovery checks each key:
     - charged → refund with `<key>:refund`
     - not charged → drop the intent
     - a pending settle → re-run it (steps already done are skipped by key)
   - One mutex serialises mutations. There is no `BEGIN/COMMIT` around HTTP work (the site shares one SQLite
     connection).
4. **Timers are absolute deadlines in the state**, checked by one service tick (250 ms for tables, longer for
   draws and epochs). There is no per-object `setTimeout`. Deadlines missed during downtime get a grace period, or run
   immediately for scheduled draws, by policy.
5. **Fairness for anything random** (lotto, raffles if they ever move): commit at open (`sha256(server_seed)`), HMAC
   derivation, reveal plus a `/…/fair/...` verify page (casino `fair.js`).
6. **Transport to Pepe.**
   - `POST /api/<svc>/bot/act {password, room, username, camfrog, verb, args, idem, channel}` returns
     `{ok, reply, private}`.
   - `POST /api/<svc>/bot/poll {password, after, wait<=8, rooms}` is a long-poll with a cursor; events are kept 48 h.
   - Use POST so the staging router falls back to the sandbox.
   - Pepe uses one ordered worker for acts and its own poll thread, so packet handlers are never blocked.
   - Each new bot path needs a `staging.py` handler (ci/check.py enforces it).
7. **Two flags, both default off.**
   - Site flag (`<svc>_settings.enabled`): default ON on staging (`STAGING` env), OFF on prod.
   - Per-instance or per-room bot flag (`casino_client.json` style): default OFF everywhere.
   - The bot refuses to switch while a local game is in flight.
8. **Cutover between events.**
   - Freeze (flag the old path to refuse new entries).
   - Export the bot JSON, import it into site tables, and **verify totals**: every pool, hold and ticket sums to the
     same PAT, and the supply snapshot is unchanged.
   - Flip the flags, then keep the old engine read-only for one cycle.
   - Deploy order: site first, then bot.

**Phase 1 adds one piece the casino didn't need: site-side pools.** A `pools` table (key → balance, kind, layer) and a
`pool_moves` journal (key PRIMARY KEY, pool, amount, flow, ref, ts), moved only by keyed calls. This is the v1 form of
v2 `vault`-kind ledger accounts (ARCHITECTURE §6.2). It is what lets the lotto pot, escrows and the Fed live next to
the wallets.

---

## 5. Inventory

Each entry covers:
- **What**: what the feature does.
- **State**: where its data lives.
- **Pepe down**: what breaks when Pepe is offline.
- **Stays in bot**: the Camfrog-specific parts.
- **Rec**: the recommendation.
- **Effort / risk**: effort and risk.
- **v2**: where it maps in the v2 design.

### 5.1 Lotto / Pepeball — Phase 0, in progress (casino pattern)
- **What**: weekly 4-of-30 + Pepe Ball draw, Sunday 9 pm ET (`LOTTO_DRAW_DOW=6`, `LOTTO_DRAW_HOUR=21`).
  - Tickets cost 1,000 PAT.
  - 40% of each ticket goes to the lotto pot (`LOTTO_POT_SHARE`, vault `"lotto"`). The other 60% is routed by flow
    `lotto_tickets` (`_route_fees`).
  - Fixed prizes are paid from `LOTTO_VAULT = "jackpot"` (the House).
  - The jackpot comes from the lotto pot, capped.
  - After a hit, the pot is reseeded with `LOTTO_POT_RESEED` 1M (`_v2_lotto_reseed`, or a `reserve` → `lotto`
    `_vault_transfer`).
  - RNG: `random.SystemRandom()`, with no commit-reveal.
- **State**:
  - bot: `lotto.json` (tickets, draw, history, `pending_draw`), and the pot in `turf_data.json["vaults"]["lotto"]`
  - site: `lotto_state` (a single-row mirror) and `lotto_last_tickets`
- **Pepe down**:
  - Web purchases queue (C1).
  - The draw runs late, whenever Pepe is back.
  - `/lotto` goes stale.
- **Stays in bot**: `!lotto` verbs as a thin client, the room announcement, the overlay `lotto` events
  (start/ball/result/closed), lotto cosmetic drops (`_cos_drop_async`), and inbox notices if the site doesn't send
  them.
- **Note for the lotto move**: the pot is a Pepe-local pool. The other ways money reaches it also have to land on the
  site: `!donate lotto` (pepe_donate), `!econ fund lotto` Fed grants (pepe_monetary `FUND_*` maps), and the reseed.
  Otherwise they keep writing a pool that no longer pays anything.
  - Smallest safe option: the lotto service owns a `lotto` pool row (the first `pools` row, section 4).
  - Pepe's donate and fund commands become calls to it.
  - Add commit-reveal to the draw (the v2 L-3 "lotto draw" done-criterion).
- **Effort / risk**: M / M.
- **v2**: `pat-contracts` lotto contract + games-service draw engine (L-3).

### 5.2 Casino: blackjack (done on staging), hold'em (phase 2)
- Blackjack is phase 1 on staging per `docs/casino-backend.md`. Prod rollout is decision D1.
- Hold'em is still in the bot:
  - state: `poker_engine.py`, `holdem_escrow.json`; the web mirror is `tables.js` (`/api/tables/sync|claim|act`)
  - web seats go through the `table` fast lane
- The old `pepe_tables.py` mirror and the `kind:'table'` lane can be retired once both games are on the backend.
- **Effort / risk**: L / M. **v2**: games service + `table_session` contract.

### 5.3 Pools, routing table and economy settings — Phase 1 (the foundation)
- **What**:
  - Pools: every `turf_data.json["vaults"]` pool listed in section 1.
  - Routing: the PAT Routing table (`pepe_routes.py` `ROUTE_FLOWS`, global setting `pat_routes`), which decides where
    each charge goes and which pool pays each reward (`_fund_source`, `_fund`, `_route_pat`, `_route_reverse`).
  - Settings: the `econ_cfg` settings (`pepe_econcfg.py`, in `bot_settings.json`, audit `econ_cfg_log`).
  - Journals: the Fed journals (`econ_layers.fed_mints`, `fed_grants`, `fed_loans`).
  - The vault flow ledger (`pepe_vaultlog.py`, `vault_ledger.json`).
- **Pepe down**:
  - Funding claims pile up, and the site's view of balances goes stale.
  - After a site restart, the economy falls back to legacy routing (section 3.1).
  - Pepe is the only writer of every protocol pool.
- **Stays in bot**: the `!econ`, `!reserve`, `!vault`, `!donate` chat commands, as thin clients calling the site.
  - The admin card can move from Pepe's admin panel (`admin_server.py` `/api/econ/config`, `/api/econ/fund`) to
    `/admin/economy` on the site.
- **Rec**: **move.**
  - Site tables `pools` and `pool_moves` (keyed), `routes` (the `ROUTE_FLOWS` rows plus overrides), and `econ_cfg`
    (with its log).
  - New keyed bot routes:
    - `POST /api/pat/charge {user, amount, flow, room, payer, key}`: debits the wallet **and** applies the routing
      split in one site transaction. This replaces `/api/wager/charge` + `_route_pat` and closes section 3.2.
    - `POST /api/pat/fund {flow, user, amount, key}`: pool → wallet, replacing `_fund` + `chatwinner`.
    - `POST /api/pools/move {from, to, amount, flow, key}`: replaces `_vault_adjust` / `_vault_transfer`.
  - `funding.js` then reads pools directly. The `reserve_claims` settlement loop and the in-memory `funding.state`
    are no longer needed (keep the table read-only for history).
  - Pepe keeps running the policy ticks (Phase 4) against the site API until they move.
  - Hot-path rule: every Pepe call to these routes goes on an ordered worker (`pepe_cmdnet` style). A chat handler
    never waits on the network.
- **Cutover**:
  - Turn `econ_treasury` off for the window.
  - Export the `vaults` map and journals, import them, and verify against the last `/api/stats/supply` snapshot (pool
    by pool).
  - Then flip the bot flag (`pools_backend`). Do it between Monday epochs.
- **Effort / risk**: L / **H**. This touches every money path. It needs a staging soak with the existing tests
  ported: routes_test, layers_test, treasury_test, monetary_test, econcfg_test.
- **v2**: `pat-ledger` vault accounts + flow versions (§6.2–6.5), the L-5 compatibility facade, and L-6 genesis
  (pools already on the site make genesis a site-only snapshot).

### 5.4 Website funding claims (`reserve_claims`, `_funding_tick`)
- **What**: the site pays welcome (`welcome.js`), levelup, achievements (`achievements.js` → `fundPayout`), codes
  (`takeFunds("redeem_codes")`), Discord/Twitch rewards, boost/slot-fee halves (`boosts.routeInTx`), royalties
  (`royalties.js`), the staff grant, House flash (`houseFlashCover`) and donation mints (`cryptopay.js`,
  `stripebilling.js`). Pepe settles all of them.
- **Pepe down**: section 3.1 and 3.3.
- **Rec**: this goes away with 5.3. Each claim becomes a direct keyed pool move in the same transaction as the wallet
  credit.
  - The incentive queue (`queued=1`, `drainQueue`) stays as site logic.
  - Donation mints (`mint:donation`) become a site-side Fed mint journal row. v2 §6.9 already says only the payment
    service may call it.
- **Effort / risk**: S once 5.3 is in / M.

### 5.5 Charge + route for paid commands (`_charge_pat`, `_route_pat`, `pepe_econ` attribution)
- **What**:
  - Paid commands, surcharges, songs, voices, shout-outs, heist gear, gang creation, `!sponsor`, fines and casino
    losses are all charged on the site, then routed by the bot.
  - E-0 attribution (`_econ_note` → `POST /api/econ/charges`) is posted afterwards as a separate feed.
- **Rec**: part of 5.3 (`/api/pat/charge`).
  - Attribution is written by the same transaction, so `econ_charges` no longer depends on a second POST from Pepe.
  - The Camfrog side still decides the price (`_cost`) and the room.
- **Effort / risk**: M / M.

### 5.6 Cosmetics purchases from the web
- **What**: `/cosmetics/act` (cosmetics.js:867) queues `!cosmetic buy|gift|buylisting` to Pepe, who charges and then
  calls `/api/cosmetics/grant|transfer`. Items already live on the site (`user_cosmetics`). Pepe only moves the PAT,
  because the `cosmetics` routing row lives in Pepe.
- **Pepe down**: web purchases stall. A linked Camfrog name is required just to buy a hat on the website.
- **Stays in bot**: `!cosmetic` in chat (calling the same site endpoint) and Camfrog-event drops (5.17).
- **Rec**: move right after 5.3. A site endpoint charges with flow `cosmetics` and grants or transfers in one
  transaction. Unlinked users can buy too.
- **Effort / risk**: S / L.

### 5.7 Polls
- **What**: one room poll at a time across rooms.
  - bot: `polls.json` (`pepe_webact.py` `POLLS_FILE`)
  - site: mirror `/api/polls/sync`
  - web votes, create and end go through C1 (`poll.vote/create/end`)
- **Pepe down**: web votes queue, and the page is stale.
- **Stays in bot**: `!poll` / `!vote` in chat, the room announcement, the chat tally, and the overlay if any.
- **Rec**: move. The site owns the poll and votes; Pepe is a client (`/api/polls/bot/act`, `/bot/poll` events). No
  money is involved, so this is a good first non-casino use of the pattern. It can run in parallel with Phase 1.
- **Effort / risk**: S / L. **v2**: `rooms` service (polls are listed there, §4).

### 5.8 Escrow games: wagers, parimutuel pools, bounties, P2P loans, donations, challenges
- **What**: `pepe_escrow.py` (`escrow.json`) is the shared crash-safe hold/settle/refund ledger.
  - It holds through `/api/wager/charge` and pays through `/api/wager/payout`.
  - Fees go to pools via `fee=`. Refs: W (wager), M (market/pool), L (loan), B (bingo), plus bounty ids.
  - Features on it:
    - `pepe_wager.py` (`wagers.json`)
    - `!pool` parimutuel in `pepe_market.py` (`markets.json`, model `pool`)
    - `pepe_bounty.py` (`bounties.json`) + `pepe_bountyverify.py`
    - `pepe_loan.py` P2P offers (`loans.json`)
    - `pepe_donate.py`
    - `pepe_challenge.py` (prizes from the room's escrow on PATV)
    - `pepe_mktresettle.py`
  - Deadlines run in `_escrow_sweep` (30 s heartbeat): `_wager_sweep`, `_market_sweep`, `_loan_sweep`,
    `_bounty_sweep`, `_chal_sweep`, and so on.
- **State**: bot JSON files. The site has mirrors only (`wagers`, `bounties`, `markets`, `wallet_snapshots`) and the
  `bounty_actions` / `market_orders` queues.
- **Pepe down**:
  - No web accept, settle, bet, claim or chip-in.
  - Deadlines (auto-refund at expiry, loan auto-collect every 10 min, late penalties) stop until Pepe returns.
- **Stays in bot**:
  - the chat verbs (`!wager`, `!pool`, `!bounty`, `!loan`, `!accept` / `!decline` routing in `handle_offer_reply`)
  - room announcements
  - **bounty evidence**: `pepe_bountyverify.py` searches Pepe's mod log, chat logs, transcripts and join journal. It
    should call the site's resolve endpoint with its finding. The site stays the settlement authority.
  - mic-challenge capture and audio judging
- **Rec**: **move** as one generic site escrow service (`escrow_holds`, `escrow_payouts` keyed `<kind><id>:<user>:<op>`)
  with per-kind state machines.
  - It replaces `escrow.json`. Same journal semantics: a "charging" hold → refund on recovery.
  - Order inside the phase: wagers → bounties → parimutuel pools → P2P loans → donations/challenges.
  - The judge rules (named arbiter, disputes, void refunds) carry over unchanged.
- **Effort / risk**: L / M. **v2**: `pat-contracts` wager / bounty / loan / split contracts (L-3, L-4), B-6 family
  "escrow games".

### 5.9 LMSR prediction markets and the market-maker vault
- **What**: `pepe_amm.py` (b=50000, 2% fee) + `pepe_market.py`.
  - Seeds come from the MM vault (`mm` cash). Voids return the seed first.
  - Re-settle goes through `pepe_mktresettle.py`.
- **State**: bot `markets.json`, plus `mm` cash in `turf_data.json`; site mirror `markets` + `market_orders`. The
  site's `lmsrPrices` is display-only. **Pepe owns the market state.**
- **Pepe down**: no buy, sell or settle. Prices shown on `/markets` are stale.
- **Stays in bot**: `!market` verbs (thin client), room announcements, AI-judge evidence (5.15).
- **Rec**: move after 5.8 (it reuses the escrow service for the pot). Port the LMSR maths to JS with a
  vector-replay test, like the casino did (`casino-bj-vectors.json.gz`). Settlement and voids become keyed site
  transitions.
- **Effort / risk**: M / M (price maths must match exactly). **v2**: `market` contract (§17.2, L-4 notes).

### 5.10 Reserve (Fed) loans to players and the Bank vault
- **What**: `pepe_loan.py` LR requests and approvals with an instant limit by level and credit score (`pepe_credit.py`;
  site mirror `credit.js` via `/api/wallet/loans`). They are funded by the Bank vault (`bank` cash). Defaults are
  insured by the Reserve.
- **Pepe down**: no requests, approvals or collection.
- **Rec**: move with 5.9 and 5.11. Bank NAV = cash + outstanding principal, so loans and the Bank's share accounting
  should land together. The credit score becomes a site read model over loan history (L-4 note).
- **Effort / risk**: M / M.

### 5.11 Staking (capital vaults) and personal stashes
- **What**:
  - `pepe_vaults.py` (`vaults.json`): ERC-4626-style shares in Bank / House / MM / Auto.
  - Daily 04:00 UTC cut-off queue, APR ceiling, and protocol dividend above basis.
  - `pepe_stake.py` (the older stakers pool).
  - `pepe_pvault.py` (`pvaults.json`): personal stashes with grants.
- **State**: all in the bot. The site only shows `staking_state` / `staking_daily` and `/api/wallet/stashes`.
  - House NAV = the site jackpot (read remotely). Bank and MM NAV depend on 5.9 / 5.10.
- **Pepe down**: no stake or unstake (those are queued requests anyway), no stash withdrawals. **Players can't reach
  PAT they parked in a stash.**
- **Rec**: move after 5.9 and 5.10. Stashes are player funds and should become site sub-accounts first; that part is
  simple (S–M) and can go earlier. The share accounting and epochs come next.
- **Effort / risk**: L / **H** (share maths, history). **v2**: `vault` contracts + "every v1 pool shows up as a wallet"
  (L-7).

### 5.12 Policy ticks: treasury epoch, monetary, automint, burn, Casino-vault feed
- **What**:
  - `pepe_treasury.py` `_tr_tick`: the Monday 04:00 UTC surplus waterfall, the daily release and grants.
  - `pepe_monetary.py` `_mo_tick` (daily 04:00 UTC): Fed band floor mint / ceiling release, the Monday guarantee,
    issuance, mint caps, flash, Fed grants and loans.
  - `pepe_burn.py` `_burn_tick`: the burn-reserve accrual. The site records each burn via `/api/g/burns/record`.
  - `_automint_tick` (hourly, off under layers).
  - `_heist_vault_tick` (the Casino vault's 15% House-profit feed).
  - `_wheel_cut_tick` (hourly).
  - `pepe_layers.py` `_layers_tick` (interrupted Fed-mint recovery).
- **State**: inside `turf_data.json` (`econ_*`) + `vaults.json`.
- **Pepe down**: the epoch and daily ticks run late. `BOOT_GRACE` and `armed_at` guards stop them running twice. With
  layers on, nothing pays the guarantee until Pepe is back.
- **Stays in bot**: `!econ` / `!reserve` commands as clients, the announcements, and the admin inbox notices if those
  aren't already site-side.
- **Rec**: move to one site scheduler service after 5.3 and 5.11. They are pure functions of pool balances, vault NAVs
  and participation data, and the participation data is already on the site (`econ_participation`). Port with the
  existing Python tests as vectors (treasury_test, monetary_test, burn_test).
- **Effort / risk**: M / **H** (these move the most PAT per run).
- **v2**: Fed / Treasury / heist `vault` contract parameters and transitions (WORK-PACKAGES L-4 "Economy v3"); burn
  reserve as a locked account (§17.62).

### 5.13 Room vaults (E-3) and the pad launchpad
- **What**:
  - `pepe_roomvault.py`: a `room:<id>` pool per pad.
    - Accumulate only.
    - Credits come from `_rv_route`, from site `room:` claims and from deposits.
    - Above the cap it overflows to Fort Knox.
    - The site mirror is `roomvaults.js`, which also stores the owner's payout rate for E-4.
  - `pepe_launchpad.py`: grants from incentives. Momentum is measured on the site.
- **Pepe down**: room halves of boosts get misrouted after a site restart (section 3.1). Nothing is paid out, but
  balances drift.
- **Rec**: move with 5.3 (they are just pools plus a routing destination), then the E-4 epoch with 5.12. The site
  already has the pad registry, so the vault belongs next to it.
- **Effort / risk**: M / M. **v2**: the `room_vault` contract (`vault:room:<pad>`, L-4).

### 5.14 Achievements
- **What**: catalog on the site (`achievements.json`, `badges`).
  - Bot-side metrics are counted in `pepe_achievements.py` (`achievements_progress.json`, `_ach_bump`) and awarded
    via `/api/g/achievement`. The site pays the PAT (`fundPayout("achievements")`).
  - Web-side metrics are counted by the site (`checkWeb`). Pepe announces them via `_ach_tick` polling
    `achievement_feed`.
- **Pepe down**: Camfrog-side counting pauses (expected; the events are Camfrog events). Web achievements still award;
  only the room announcement waits.
- **Stays in bot**: everything that observes Camfrog (chat, commands, mic, kicks), and the announcements.
- **Rec**: **split, low priority.** Move counter storage to the site (`POST /api/g/achievement/bump {login, metric,
  n, key}` batched from the existing 30 s tick; thresholds evaluated on the site). The catalog, counters and awards
  then live in one place, and a bot JSON file goes away.
- **Effort / risk**: M / L. **v2**: `pat-assets` (achievements, items).
- **Built 1.99to (site + bot), staging ON, prod pending the user's go:** `achprogress.js` (counters per login, exact decimals,
  keyed metric events, thresholds evaluated on the site for the metrics a bump touched, awards through `achievements.award` =
  the achievements group) + bot `pepe_achstore.py` (mirror + diff + keyed outbox behind `!achievements backend`). Cutover,
  rollback, detach and the staging rehearsal against a prod copy: `docs/achievements-cutover-runbook.md`.

### 5.15 AI market judge
- **What**: `pepe_aijudge.py`.
  - It proposes a result for markets, pools and wagers using web search plus Pepe's own Camfrog records: chat logs,
    transcripts, `greeter_seen`, `activity.json`.
  - Then a dispute window (60 min).
  - Retries at 15 min / 1 h / 3 h, then it escalates to admins.
  - The journal is in `pepe_bgsave`.
- **Pepe down**: no proposals. Markets wait; they don't break.
- **Rec**: **split.**
  - The site owns the proposal record, the dispute window and the settle transition.
  - The bot (or v2's agent runtime) is an oracle client that posts `{proposal, confidence, evidence}`.
  - The Camfrog evidence must stay where the logs are. Price questions settle from typed price data first (v2 §17.81).
- **Effort / risk**: M / M. **v2**: `ai_oracle` resolver (L-4).
- **Built 1.99to:** site `oracle.js` (proposals, disputes, the window, the settle by the item's owner through pluggable
  resolvers: escrow pools / wagers on the site settle there, Pepe-owned items go "due" on a feed) + bot `pepe_aioracle.py`
  behind `!aijudge backend on|off` (proposals keyed and queued; nothing finalised locally while on). Phase 3 plugs its LMSR
  markets in with `oracle.registerResolver("market", ...)`. Contract: `docs/oracle-contract.md`. Q5 answered by it: the
  settlement half moves now, the judge stays in Pepe until v2's agent runtime.

### 5.16 Economy telemetry and supply snapshot
- **What**:
  - `pepe_econ.py` posts charges and participation (`/api/econ/charges`, `/api/econ/participation`).
  - `_supply_tick` posts Pepe's pools every 300 s (`/api/stats/supply` → `supply_snapshot`, `supply_history`).
- **Rec**: **split.**
  - Participation stays a bot feed: chat lines and mic minutes are Camfrog signals.
  - Charges and pool rows are produced on the site once 5.3 lands. Only the Pepe-only pools (gangs, turf, heist
    escrow) remain in the push.
- **Effort / risk**: S / L.
- **Built 1.99to:** `supply.js` (patSupply out of index.js): every pool the site owns is counted from its own table
  (pools, room vaults, stashes, gangs, escrow holds, the lotto pot, route intents, pad-vault escrow) and a new site row
  `casino:tables` counts PAT at the casino backend's tables (blackjack stakes in a round, hold'em stacks and pots - out of
  the wallets, not in the House yet). Pepe's push shrinks to what he holds (turf stakes / tills / season pot / cargo, room
  wars, journaled payouts, the markets until Phase 3, and anything still local on his side). Verified on a prod DB copy
  2026-10-12: 1,104,246,235 with his old full snapshot = with the shrunk one = the live prod endpoint; no row moved.
  Charges and participation stay bot feeds: participation is chat lines and mic minutes, and a charge's telemetry row
  carries Camfrog attribution (command, room) - the PAT itself already moves through the site's keyed charge (Phase 1).

### 5.17 Cosmetic drops
- **What**: Pepe owns the drop table. It pushes `/api/cosmetics/drop-config` (wheel rates) and grants organic drops
  for Camfrog events (`odrop-` keys, daily cap enforced by the site).
- **Rec**: the drop **config** moves to the site (it already enforces the cap). Event-triggered drops stay where the
  events happen (bot for Camfrog games, site for the wheel and lotto once moved).
- **Effort / risk**: S / L.
- **Built 1.99to:** the whole table (every event's chance, the cap, the gates, the event-pool share) on the site
  (`cosmetic_drop_config` + `cosmetic_drop_meta`), handed over once by `!cosmetics backend on confirm`, edited on
  `/admin/cosmetics`, released back with `off`. **Rolling stays where the event happens** (the safer choice: a Camfrog game's
  drop never waits on a network round trip or fails with the site, the grant + the daily cap were already the site's,
  `grantCapped` in one statement): Pepe rolls his events with the site's numbers (read every 5 min, the last copy kept for an
  outage); the site rolls the wheel and the casino backend's seats with the same table.

### 5.18 Camfrog-native live games: raffles, top mic, trivia, pictionary, bingo, PvP
- **What**:
  - raffles: `start_raffle`, `_start_all_raffles`, per room
  - top mic: hourly top-mic reward (`_start_mic_hourly` → `_award_top_mic_hour`, from mic sessions)
  - trivia: `handle_trivia`, `_trivia_credit`
  - pictionary
  - bingo: `pepe_bingo.py`, pot vault `bingo`
  - PvP: duel / brawl / arena (`duel_records.json`)
  - sponsors: `!sponsor` (`sponsors.json`)
- **Rec**: **keep in the bot.** The game *is* the chat, mic and overlay. Their money already goes through flows
  (`raffle`, `mic_hourly`, `pictionary`, `roomgames` budget). After 5.3, payouts become `/api/pat/fund` calls and the
  bingo pot and duel stakes become site escrow holds (5.8). The engines move only in v2 (B-6 "casino" and "PvP"
  families, games service).

### 5.19 Heists — PINNED by the user (note only)
- `heist_data.json`, `heist_cooldowns.json`, `heist_ring_*.json`.
- Pays from Fort Knox / the Casino vault (local pools) and the House.
- Not recommended for this migration. After 5.3, heist payouts automatically draw from site pools through the same
  calls, which is the only change this audit implies.

### 5.20 Turf and gangs
- `turf_data.json` (areas, stakes, tills, cargo, season pot) and `gang_data.json` (treasuries).
- The turf daily tick is a `threading.Timer` (`_start_turf_daily`). Invasions reuse the heist engine.
- Live pages are rendered by Pepe (`_publish_turf_page`, gangs page → Netlify).
- **Rec**: keep with heists. Two exceptions:
  - The pages move to the site under W-2 (Netlify absorption).
  - **Note:** splitting the pool store out of `turf_data.json` (5.3) separates the economy from the turf file. That
    also makes a later turf move much smaller.

---

## 6. Phases

Each phase lists its v2 alignment. The order goes money-safe first, foundation before features, which is the same
rule as v2 §16 ("riskiest thing (money) first").

### Phase 0 — in progress
- **Casino blackjack**: phase 1 on staging (site 1.99ln/ls, bot 1.99lo/lt). Prod rollout per D1.
- **Lotto / Pepeball** (another agent, branch `lotto-backend-site` / `lotto-backend-bot`): casino pattern.
  - The site owns tickets, draw and pot.
  - Pepe becomes a thin `!lotto` client plus overlay and announcements.
  - Carry the `lotto` pot and its feeders (donate, Fed grants, reseed) as noted in 5.1.
  - Add commit-reveal.
- **Hold'em** (casino phase 2, pending the user).
- **v2**: games service engines + `table_session` / lotto contracts (L-3 done-criterion: "a lotto draw and a blackjack
  session run end to end").

### Phase 1 — pools, routing, settings on the site (foundation)
- 5.3 pools + routing + `econ_cfg` + Fed journals → site tables. Add the keyed bot routes `/api/pat/charge`,
  `/api/pat/fund` and `/api/pools/move`.
- 5.4 the `reserve_claims` settlement loop retires, and `funding.state` stops being in-memory.
- 5.5 charge and route in one transaction (closes section 3.2).
- 5.6 web cosmetics purchases without Pepe.
- 5.7 polls (no money; can ship in parallel as the first non-casino client).
- Also: the routing/economy admin card moves from Pepe's `:8766` panel to `/admin/economy`.
- **v2**: L-1 ledger data model in v1 form (vault accounts, flows), L-5 compatibility facade (the same routes later
  sit on the real ledger), and L-6 genesis prep.

### Phase 2 — escrow games on one site escrow service
- **Built 1.99ou (site + bot), staging:** `escrow/ledger.js` (every escrowed stake, keyed one-transaction hold / refund / settle /
  grant, supply row, import / export / rollback) + `escrow/games.js` with the wager, bounty, pool and P2P-loan engines; bot
  `pepe_escrowstore.py` / `pepe_escrowgames.py`. Switches, cutover, rollback, detach and the staging rehearsal:
  `docs/escrow-cutover-runbook.md`. Bingo, duels / brawls, mic challenges, donations, shout-outs, cosmetics and room-vault
  deposits keep their engines in Pepe and hold their stakes on the same ledger.
- 5.8: wagers → bounties (bot remains the evidence verifier) → parimutuel pools → P2P loans → donations and mic
  challenges.
- The `market_orders` / `bounty_actions` queues and C1 `cmd` kinds for these retire.
- Bingo pot and duel stakes can use the same holds.
- **v2**: `pat-contracts` wager / bounty / loan / split contracts (L-3, L-4); B-6 "escrow games" family.

### Phase 3 — the capital cluster
- 5.9 LMSR markets + MM vault, 5.10 Reserve loans + Bank vault, 5.11 staking shares + stashes (stashes can go first,
  at the end of Phase 1 or in Phase 2).
- These three have to land together or in that order, because Bank and MM NAV include outstanding loans and seeds.
- **v2**: `market` contract, `vault` contracts, L-7 "every v1 pool shows up as a wallet".

### Phase 4 — policy engines on a site scheduler
- 5.12 treasury epoch, Fed band / Monday guarantee / issuance, burn accrual, Casino-vault feed, wheel cut.
- 5.13 room vaults + launchpad + E-4 epoch.
- Ship them during a week with no Monday-epoch change, with a dry-run mode first. Both monetary and treasury already
  have dry runs.
- **v2**: Fed / Treasury / `room_vault` contract transitions (L-4 Economy v3 notes).

### Phase 5 — splits and leftovers
- 5.14 achievement counters to the site, 5.15 AI judge as an oracle client, 5.16 telemetry, 5.17 drop config.
- **Built 1.99to (site + bot), on staging 2026-10-12.** Achievements cutover rehearsed against a fresh prod copy (match,
  one live unlock exactly once, exact rollback, cut over again and left ON); the supply total verified unchanged on a prod
  DB copy; the oracle settles a real escrow pool in the site's tests; the drop table hand-over / release in both test suites.
  Prod: deploy site then bot (all switches default OFF on prod), then each switch with the user's go - see each runbook.
- **What stays in Pepe from Phase 5 on:** the observing (every achievement hook, the quiet backfills, announcements), the
  judge's research and evidence (web + Camfrog records + vision) and its retry / escalation schedule, rolling the drops of
  Camfrog games, participation and charge telemetry.
- **v2**: `pat-assets`, the `ai_oracle` resolver, `search` / analytics.

### Stays in the bot (v2: cf-connector + botkit modules, B-2 / B-6)
- chat verbs as thin clients
- announcements, PMs and the OBS overlay (`avatar_server` events)
- everything that observes Camfrog: chat, mic sessions, cams, mod events, participation, achievements metrics,
  bounty evidence, judge evidence
- live Camfrog games (5.18)
- heists, turf and gangs (pinned)

---

## 7. Per-move checklist (copy into each PR)

1. Site service + tables + keyed money steps. A replay test proves the engine matches the Python, as with the
   blackjack vectors.
2. Site flag (default on in staging, off in prod) and per-instance bot flag (default off). The bot refuses to switch
   while a local game is in flight.
3. Bot thin client: an ordered worker for acts, a long-poll thread for events, no network on packet handlers, and
   `staging.py` handlers for every new path (ci/check.py).
4. Web actions call the service directly. Remove the C1 kind and its `CMD_ALLOW` entry when the old path retires.
5. Cutover runbook:
   - freeze
   - export the bot JSON
   - import
   - **verify totals** (per pool and per hold, and the supply snapshot is unchanged)
   - flip the flags
   - keep the old engine read-only for one cycle
   - take a prod DB backup first (`/home/PATV-backups/…`)
6. Deploy the site first, then the bot. Money-moving changes need the user's explicit approval before the prod flag
   flips (economy-v2-rollout rule).
7. Update v2 docs §17 with what moved (v2-rebuild rule: the docs are the shared source of truth).

---

## 8. Open questions for the user

- **Q1.** Phase 1 scope: move all pools in one cutover, or pool by pool (lotto pot first via Phase 0, then Fed / Fort
  Knox / incentives, then the rest)?
  - Pool by pool means Pepe must handle mixed local and remote pools for a while. `_vault_total` already does this
    for the jackpot, so it is feasible.
- **Q2.** Should the routing/economy admin card move to the site in Phase 1, or stay on Pepe's panel (editing a site
  table through the bot token) until v2's admin console?
- **Q3.** Web actions queued while Pepe is down currently run whenever he returns. Until each feature moves, should
  `pepe_actions` expire pending rows after N minutes ("Pepe was offline, nothing was done")? This is a small change
  that limits section 2's late-execution risk.
- **Q4.** Polls: one global poll at a time (today), or one per room/pad once the site owns them?
- **Q5.** AI judge: keep it in the bot until v2's agent runtime, or move the settlement half to the site now?

---

## Appendix A — bot → site endpoints that carry Pepe-owned state (C2/C3)

| Endpoint (site file) | Pushed / claimed by (bot) | Retires in |
|---|---|---|
| `/api/lotto/sync` (lotto.js) | `pepe_lotto.py` | Phase 0 |
| `/api/tables/sync`, `/api/tables/claim` (tables.js) | `pepe_tables.py` | Phase 0 (BJ done; hold'em phase 2) |
| `/api/g/funding-sync`, `/api/g/reserve-claims[/settle]` (index.js → funding.js) | `_funding_tick` | Phase 1 |
| `/api/stats/supply` (index.js → supply.js) | `_supply_tick` | shrunk in 1.99to (only Pepe-held rows) |
| `/api/econ/charges` (econ.js) | `pepe_econ.py` | Phase 1 (produced on site) |
| `/api/polls/sync` + C1 `poll.*` | `pepe_webact.py` | Phase 1 |
| `/act` `cmd=cosmetic`, `/cosmetics/act` | `pepe_cosmetics.py` | Phase 1 |
| `/api/wagers/sync` (wagers.js) | `pepe_wager.py` | Phase 2 |
| `/api/bounties/sync`, `/api/bounties/actions/claim|ack` | `pepe_bounty.py` | Phase 2 |
| `/api/markets/sync`, `/api/markets/orders/claim|ack` | `pepe_market.py` | Phases 2–3 |
| `/api/wallet/loans`, `/api/wallet/stashes` (wallet.js) | `pepe_loan.py`, `pepe_pvault.py` | Phase 3 |
| `/api/staking/sync` (staking.js) | `pepe_vaults.py` | Phase 3 |
| `/api/g/burns/record` (burns.js), C1 `econ.burn` | `pepe_burn.py` | Phase 4 |
| `/api/g/roomvaults/sync` (roomvaults.js), `/api/g/launchpad/*` | `pepe_roomvault.py`, `pepe_launchpad.py` | Phase 4 |
| `/api/g/achievement` (index.js) | `pepe_achievements.py` | Phase 5: awards from `/api/achievements/bot/events` once the counters live on the site (backfills keep it) |
| `/api/cosmetics/drop-config` | `pepe_cosmetics.py` | Phase 5: ignored once the site owns the table (`/drop-config/state` instead) |
| `/api/userstats/sync`, `/api/roomstats/sync`, `/api/econ/participation` | `pepe_userstats.py`, `pepe_roomintel.py`, `pepe_econ.py` | stay (Camfrog signals) |

## Appendix B — bot state files that hold PAT or PAT claims

| File | Holds | Moves in |
|---|---|---|
| `turf_data.json` → `vaults` | Fed, Fort Knox, incentives, Casino vault (`heist`), bank, mm, lotto, stakers, bingo, burn, `room:<id>`, `vaultfloat` | Phase 1 (lotto pot: Phase 0) |
| `turf_data.json` → `econ_layers` / `econ_monetary` / `econ_treasury` / `econ_launchpad` / `econ_rooms` | Fed mint / grant / loan journals, policy state | Phases 1 + 4 |
| `turf_data.json` → `areas`, `cargo`, `season_pot` | turf stakes, tills, convoy cargo | pinned (turf) |
| `lotto.json` | tickets, pending draw | Phase 0 |
| `escrow.json` | holds and pending payouts of every escrow game | Phase 2 |
| `wagers.json`, `bounties.json`, `loans.json`, `markets.json` | per-feature state | Phases 2–3 |
| `vaults.json`, `pvaults.json` | staking shares, epochs, personal stashes | Phase 3 |
| `holdem_escrow.json`, `blackjack_escrow.json` | old-engine table stakes | Phase 0 (retire) |
| `gang_data.json`, `heist_data.json` | gang treasuries, heist sheets | pinned |
| `achievements_progress.json` | counters (no PAT) | Phase 5 (1.99to: `ach_progress` / `ach_metrics`, moved marker after the cutover) |
