# Casino backend: blackjack and hold'em on the site

## Sit & Go tournaments (handoff 22, phase 1)

A sit & go is one Hold'em table (`casino/holdem.js`, game `"holdem"`) with a `tourney` block; `casino/tourney.js` owns that block
and is installed on the same core as Hold'em (`casino/service.js` `TN`). The table page, the action bar, pre-moves, sizing, the
60 s clock + time bank, the stream slot, Pepe's poll / OBS board, the veil masks and the per-hand fairness proofs all work as
at a cash table. Phase 2 (scheduled multi-table tournaments, late registration, guarantees after H2b) is not built.

**Switch.** `casino_settings.casino_sng` = `off` (default) | `staff` (class Staff and up, or `casino.admin`) | `everyone`.
Hold'em on the site (`hm_enabled`) must be on too. The switch gates creating and registering only: leaving a registering
sit & go (a full refund), playing one that started and an admin's cancel always work.

**Settings** (`/admin/games` "Sit & Go", `POST /api/casino/admin/settings`, validated by `tourney.js checkSetting`, a bad stored
row reads as its default; a sit & go keeps the values it opened with):

| key | default | rule |
|---|---|---|
| `sng_fee_pct` | `10` | whole %, 0-50; fee = floor(buy-in x % / 100) |
| `sng_buyins` | `1000,5000,25000,100000` | 1-8 different whole amounts >= 100 PAT ("10k" accepted) |
| `sng_payouts` | `100\|65,35\|50,30,20` | one list per field 2-3 \| 4-6 \| 7-9: whole %, highest first, sum 100, at most 2 / 4 / 7 places |
| `sng_levels` | `10/20,15/30,25/50,50/100,75/150,100/200,150/300,200/400,300/600,400/800,600/1200,800/1600,1000/2000` | sb/bb, 1 <= sb < bb, bb rising; after the list each bb x1.5 rounded to two leading digits (3,000, 4,500, 6,800, 10,000...), sb = bb / 2 |
| `sng_level_mins` | `5` | 1-60 |
| `sng_turbo_mins` | `3` | 1-60 |

Constants (`tourney.js SNG`): 1,500 starting chips, 2-9 seats, a 60 s countdown for "start at N", a registering sit & go
is called off (full refunds) 60 minutes after it opened, at most 3 not-started sit & gos per account, a finished one's
results stay in the lobby / on its page for 15 minutes.

**Shape.** The creator picks the seats, a buy-in from the list, turbo, and optionally "start at N" (2 <= N < seats); the
creator is registered. Registration uses the cash tables' entry rule (`holdem.js seatChecks` over everyone registered):
an account, no casino ban, no dup-linked account, no second account from the same address. It starts when full, or when
the countdown runs out with N or more in (the countdown stops when a leave takes it below N). Seats follow registration
order; the first seat has the first button. No late registration, rebuys, add-ons or antes.

**Play.** Rake 0 (the engine's `rake` is 0 at a tournament table). The level's blinds are set just before each hand
(`beforeHand`), never mid-hand; the level clock is absolute while the site runs. Sitting out = blinded away: the seat is dealt
in and checks / folds at once (no 60 s wait). No sit-out limit, no idle close, no stand / cash-out / host close: the cash
paths (`cashout`, `closeTable`) return at once for a tournament table. A sit & go hand earns no casino rewards (achievements,
drops, win XP, gang rep - `service.js hmRewards`); the prizes are the payout.

**Bust-outs.** After each hand's proof (`holdem.js afterHand` -> `tourney.afterHand`): every seat at 0 chips is placed, stood
up (no cash-out) and gets a room line "🏁 {name} finished {nth} — {prize} PAT". Several on one hand: the bigger stack at the
start of that hand (saved with the hand: `tourney.hand_start`) places higher. **Equal starting stacks** share the prizes of
the places they occupy: floor(sum / n) each, and the leftover (< n PAT) one PAT each to the higher places; who takes the
higher place among them is the hand's **odd-chip order** - clockwise from the button, the engine's own rule for the odd chip
of a split pot (deterministic, not an account or random order). The last player left is 1st.

**Prizes.** pool = buy-in x entrants (the field at the start); each paid place = floor(pool x % / 100); whatever that
leaves (< one PAT per paid place) goes to 1st. So prizes always sum to the pool and prizes + fees always equal what is held.

### Money

Every PAT move is ONE `dbUtils.tx`: the escrow leg (`escrow/ledger.js` in-transaction primitives), its `escrow_moves` journal
row (`seen` / `record` under the key below) and the table's saved state (`service.save` -> `casino_tables`) commit or roll back
together. A refused move changes nothing (the in-memory table is restored from a snapshot). Hold kind `TNY` (ref
`TNY-<table>`) is in `SERVICE_KINDS`: never in Pepe's mirror, never handed back by a rollback, his keyed calls can't move it.

| step | key | legs | a restart / retry |
|---|---|---|---|
| register | `tny:<table>:<user>:enter:<n>` (n = that account's nth registration here) | wallet -> hold (buy-in + fee, `requireCover`: refused with nothing held when the wallet can't cover it; refused for a casino ban) | the entrant and the hold commit together: either both are there or neither; a retry of the same request is answered from `casino_actions`; registering again after leaving is a new n |
| unregister (before the start) | `tny:<table>:<user>:refund:<n>` | hold -> wallet, in full (fee too) | `seen` = already refunded: the state is fixed up, nothing moves twice |
| start | - | none (tournament chips only) | a full field saved as registering is started by `recover`; a countdown / the registration hour keep the time they had left at the last save |
| a hand | - | none | mid-hand: the hand resumes (fresh clock for the actor); the running level keeps the time it had left at the last save (the clock pauses while the site is down); a hand that ended before its bust-outs were placed is placed again from the saved start stacks (places are idempotent) |
| finish | `tny:<table>:finish` | ONE `settleInTx`: every entry hold spent; payouts to the placed accounts; fee leg `["jackpot", fee x entrants]` = a `jackpot_rakes` row `esc-tny:<table>:finish-0` (spinId `escrow:TNY-<table>`) | the places + `status: "settling"` + the plan are saved first; `recover` / the tick re-run the settle; `seen` = paid: only marked finished. The settle runs only if prizes + fee == held (it never leaves a "kept" rest) |
| cancel (admin) / the hour's call-off | per entrant `tny:<table>:<user>:refund:<n>`, then `tny:<table>:cancel` | each hold -> wallet in full (fee too) | refused once `tny:<table>:finish` is seen (paid out); per-hold keys skip what's done |

Conservation (test/casino-sng.test.js, 6 players at 1K): wallets + House + held = 11,100,000 before, after registration
(wallets -6,600, held +6,600) and after the finish (wallets -600, House +600, held 0); 1st 3,900, 2nd 2,100, fee 600.

### The contract (web + Pepe)

- `GET /api/casino/t/:id` -> `table.tourney` (names only, masked by the table's veil; no account or hold ids): `{id, short, status:
  registering|running|settling|finished|cancelled, size, field, start_at, turbo, buyin, fee, entry, stack, level_mins, registered,
  entrants: [{name}], countdown_at, expires_at, level (1-based), sb, bb, next_sb, next_bb, level_ends_at (ms), level_secs_left,
  players_left, pool, fee_total, prizes: [PAT by place], places: [{place, name, prize, tied}], cancelled: null|cancelled|expired|empty}`;
  `me.tourney` = `{registered, place, prize}`.
- `GET /api/casino/sng` and `GET /api/casino/lobby` -> `sng`: `{on, audience, can_create, sizes, buyins, fee_pct, payouts, level_mins,
  turbo_mins, stack, countdown_secs, reg_mins, list: [row]}`; a row = `{id, short, url, host, status, size, field, registered, start_at,
  turbo, buyin, fee, entry, stack, level_mins, countdown_at, expires_at, level, sb, bb, players_left, prizes, winner, me, rooms, on_stream}`.
  Sit & gos are not in the cash lobby's `tables` nor in the poll's `open`.
- `POST /api/casino/sng/new {size, buyin, turbo, start_at, idem}`, `POST /api/casino/sng/:id/register|unregister {idem}`,
  `POST /api/casino/sng/:id/cancel {idem, reason}` (casino.admin, in the admin log as `casino_sng_cancel`) - JSON + `X-Requested-With: fetch`.
- Pepe: `POST /api/casino/bot/act` with `game: "sng"` and `verb` `""`/`list` | `new` (args `[seats, buy-in, "turbo"?, "at", N]`, up to 5) |
  `join` / `leave` / `info` (`[id-or-prefix?]`; no id = the room's sit & go, else the only one that fits) | `cancel` (`[id, reason?]`,
  the PATV account needs `casino.admin` - Pepe's `admin` flag is not enough) | `help`. `BOT_VERBS` has them. At a sit & go's table the
  bare Hold'em verbs work as at a cash table; `!sit` / `!join` register and `!stand` / `!leave` unregister while it registers, and are
  refused once it runs. The poll adds `sng` (the open rows) and each sit & go table in `tables` carries `tourney`. Events: `opened`,
  `line` (registrations, countdown, "Blinds up"), `sng` (`data.sng`: start / bust / won / finished / cancelled), `closed`.

## Own hands and show / muck (handoff 21, phase 2)

`GET /api/casino/me/hands?limit=20` requires a signed-in account, uses that account
as the membership filter, caps the list at twenty across Hold'em tables, and sends
`Cache-Control: no-store`. It returns own hole cards, board, proof, shown cards,
pot awards, net stack change and ordered replay steps. Opponents' unshown cards
and internal account keys are omitted. Labels and seats pass through
`casino/veil.js`'s round masking, including its saved-table and fail-closed paths.

`casino_actions` gains one additive nullable `replay` column. One internal record
per new completed hand (`hm-replay:<table>:<hand>`) stores masked-at-the-time
participant labels, account keys for membership and replay association, initial
stacks, and event steps `{uid,action,amount,street,board,pot,stacks}`. Its ordinary
idempotency response is only `{ok:false}`; private metadata is never returned by
the idempotency lookup. Replay writes use `dbUtils.tx`; the table JSON journals
the in-progress replay with the existing hand state. No hole cards are duplicated:
the caller's cards are reconstructed from the existing revealed deck and deal order.
The existing action/round retention is unchanged. Older hands have cards and proof,
but an empty replay and unknown net change.

`showhand on|off` (`1|0` from the page) sets a per-player, per-table preference,
default off. Showdown winners are always public; losers are shown only by choice.
The private full showdown still feeds achievements, which remain unchanged. The
table summary, log and room event all use the filtered reveal. Mucking is display
only: the unchanged fairness proof reveals the deck afterwards.

The web's My hands sheet steps action-by-action through board, pot and stacks;
public showdown cards appear at its final step. Camfrog's existing worker routes
`!sitout`, `!sitin [post]`, `!pre <kind>`, `!checkfold` and `!callany` to Hold'em.
Sizing expressions continue through the existing raw-argument path.

## Hold'em quality of life (handoff 21, phase 1)

The engine, rake, escrow keys and fairness proof are unchanged. The service stores
`pre[uid] = {kind, amount, hand, street}` and `qol[uid] = {bank, hands, timeouts,
out, since, back}` in the existing table JSON. Only the player's `me` view includes
their pre-move. The existing casino veil functions still mask seats, logs and results.

`pre check_fold|check|call|call_any|fold|off` replaces one pre-move. A changed
call amount cancels `call`; any owed bet cancels `check`. Hand/street changes clear
all selections. Execution occurs inside the existing locked action step, with the
normal engine action and a table-only `auto:` annotation. External requests retain
the existing action rate limit and idempotency keys.

`casino/sizing.js` is pure and is also served at `/api/casino/sizing.js`: the page
and service run the same parser. `min`, `max`/`all`, `pot`, `half`, percentages,
`Nbb`, `+Nbb`, `Nx`, and amounts with k/m suffixes resolve to clamped raise-TO
totals. Percentages use the pot after calling. The page previews the total.

`sitout` keeps the seat and stack, and excludes that player from subsequent deals
and blinds. `sitin` waits for a natural big-blind position; `sitin post` contributes
one big blind on the next deal (a small blind already paid counts toward it).
Only an active seat list is passed to `H.startHand`, then the complete seat ring is
restored immediately. No sit/stand or PAT operation occurs during this filtering.
A waiter only waits while the seats already playing can deal without them: when
they can't (heads-up after a break, everyone back at once), every returning seat is
dealt in at once, with only the engine's own blinds (h21 integration, 1.99alq).

Timeouts check when free, otherwise fold, retaining the seat. Two consecutive
timeouts sit out; a deliberate action resets the streak. An expired sit-out uses
the existing keyed stand/payout path after the live hand ends. Sitting-out seats
prevent the five-minute idle close from shortening their ten-minute limit; a
returning seat does not (left alone, the table idle-closes and cashes it out).

The bank is consumed by elapsed time when the normal action clock ends; an action
deducts only the used seconds. During bank use, restart deducts elapsed time and
resumes the remaining bank. A normal action clock keeps its existing restart grace.
Each tenth dealt hand refills the bank, capped at the configured maximum.

Settings (casino admin controls): `hm_sitout_mins=10`, `hm_timebank_secs=30`,
`hm_timebank_max=60`, `hm_timebank_per10=5`,
`hm_presets_pot="33,50,75,100,150"`, `hm_presets_bb="2.5,3,4"`.
Preset lists contain 1–8 positive values at most 1000; timers are bounded whole
numbers. These are controls for the existing Hold'em engine switch, not new flags.

**The rule's one-time notice (Train 3a, owner 2026-11-07):** the timeout rule shipped live, so for its first 7 days
(casino_settings `notice_from:hm_timeout` = the first boot with it, never moved) a player's first Hold'em buy-in carries
it once per account (`casino_notice_seen`): "New rule: if your timer and time bank run out you check (or fold if you can't
check). Two timeouts in a row sit you out. Sitting out for N minutes cashes you out." (N = `hm_sitout_mins`). The
website's sit answer carries `notice` (the table page's closable box, translated `js.casino.rule_timeout`); a Camfrog
player gets the reply as a PM from Pepe. `casino/notices.js`, `test/casino-hm-notice.test.js`.

Keyboard: F fold, C check/call, R or Enter confirm raise; arrows step one BB,
Shift+arrows five BB; 1–5 choose pot presets; Escape clears a pre-move.
Typing, modifier shortcuts and form controls retain their normal keys.

Status (2026-10-11): phase 1 (blackjack) and phase 2 (Hold'em) are built and on STAGING; prod gets the code DARK
(`bj_enabled` / `hm_enabled` off, every room's switch off) when the user promotes it. The user's decisions are in
section 14. Heists, web heists and heist word challenges are out of scope (pinned).

The user's brief: *"build a proper backend for the blackjack and hold em, so that the camfrog bot connects to the
backend rather than the site connecting to the state held by the bot. That way people can play on the site without
connecting to a camfrog room, but the game can still be pushed to a pad/camfrog room if wanted."*

## 1. Today (v1, before this project)

There are three blackjack implementations and one hold'em, and the state of every live table is held by Pepe.

| What | Where | State held by | Money |
|---|---|---|---|
| Camfrog blackjack `!bj` | `camfrog-bot/blackjack_engine.py` (pure engine) + `_bj_*` adapter in `frida-bot.py` | Pepe's memory (`self._blackjack`), one table at a time | `/api/wager/charge` per bet / double / split / insurance; on settle `/api/wager/payout` of the full payout, losses routed through PAT Routing (`blackjack_losses`), the profit debited from the House (`_mo_house_debit` -> `/api/g/heist/jackpot-adjust`) after a Fed flash cover (`_mo_house_cover`). Crash safety = `blackjack_escrow.json` (stranded stakes refunded on restart; the round itself is lost) |
| Camfrog hold'em `!holdem` | `poker_engine.py` + `_poker_*` adapter | Pepe's memory (`self._holdem`) | buy-in charged on sit, cash-out paid on stand, rake routed (`holdem_rake`). `holdem_escrow.json` refunds seated stacks after a crash |
| Web view of those tables | `tables.js` (`/tables`, `/poker`, `/blackjack`, `/casino/t/<id>`) + `pepe_tables.py` | Pepe pushes snapshots to `/api/tables/sync` (<= 2/s); the site keeps them in memory | the site never moves money: a web click becomes a `pepe_actions` row (kind `table`) that Pepe claims (`/api/tables/claim`, 1 s fast lane) and runs as the user's linked Camfrog name through the chat command |
| Discord blackjack | `blackjack/blackjack.js` (pm2 app `blackjack`, `discord-blackjack`) | Discord bot | `/api/blackjack/wager` + `/api/blackjack/result` in `index.js`: the House (`jackpot_rakes`) takes the wager and pays the payout, `funding.houseFlashCover` for the flash |
| PokerNow bridge | `discord-bot/botBridge.js` | external | disabled since 2026-07-19 |

Consequences the user wants gone:
- the web can only play while Pepe is online and in the table's room, and only with a linked Camfrog name;
- a Pepe restart or deploy ends the round (stakes are refunded, the hand is lost), so deploys wait for tables;
- every web click is a round trip through Pepe (1-2.5 s), and the site trusts Pepe's snapshot for display.

Rules today (Camfrog blackjack, `blackjack_engine.py`, unchanged since 2026-07-19): 6-deck shoe with a fresh
provably-fair shuffle every round, blackjack pays 3:2, dealer hits soft 17, double on any first two cards, split pairs
up to 4 hands (equal value: 10/J/Q/K split with each other), split aces get one card each and can't be resplit or
doubled, double after split allowed, insurance (half the bet, pays 2:1) when the dealer shows an Ace, the dealer peeks
for blackjack under a ten (and after insurance), no surrender. Bets 100-10,000 PAT; the High Roller role has no
maximum. 6 seats. Timers: first betting window 30 s, between rounds 10 s, insurance 18 s, 30 s per decision (time-out
= stand), 3 time-outs in a row = AFK (autobet off, removed after the hand), 3 rounds seated without a bet = removed,
two empty betting windows = the table closes. `!bet` during a round queues for the next one (charged when betting
opens). Autobet re-bets the last (or a fixed) amount at deal time. A bet the House couldn't cover is refused: the
House (casino jackpot) must hold at least 2x everything staked in the round.

Fairness today: each round commits `sha256(server_seed)` before the deal; the shoe is Python's MT19937 seeded with
`sha256(server_seed|0)`; `blackjack_fairness.jsonl` logs the commitment and the reveal (seed + whole shoe). It is
logged, not shown to players.

Economy rules that apply (economy v3, 2026-10-10): the casino is House-banked. The House is `SUM(jackpot_rakes)` on
the site. A House payout that would take it below its hard floor is covered by Fed flash liquidity
(`flash:house:<flow>` claim booked by the site, settled by Pepe as a Fed loan), never minted silently. Credits are
sourced (every credit says which pool paid it) and idempotent. Routing for this project: blackjack losses and hold'em
rake go 100% to the House (the 1.2% / 20% `turf:casino` skims are retired with turf).

## 2. Target

A **casino service in the PATV site** (Node, this repo, `casino/`) owns the tables: game state, rules, RNG and
fairness, timers and every PAT movement, through the site ledger. Everything else is a client:

```
             web UI (/casino/blackjack)            Pepe (thin client)              Telegram (never)
      signed-in PATV account, JSON + fetch   bot token, long-poll + act          gambling excluded
                        \                          |
                         v                         v
      +---------------------------------------------------------------+
      |  casino service (site process)                                |
      |  tables: engine state (pure) + timers + fairness + money       |
      |  SQLite: casino_tables / casino_events / casino_rounds /       |
      |          casino_actions / casino_settings                      |
      |  money: ledger.post (users) + jackpot_rakes (House)            |
      |         + funding.houseFlashCover (Fed flash)                  |
      +---------------------------------------------------------------+
```

- **Web-only table:** opened on `/casino/blackjack`, played by signed-in accounts. No Camfrog link needed.
- **Pushed table:** the host (or an admin) pushes a table to a pad / Camfrog room where Pepe is and the room's
  backend flag is on. Pepe announces it there and relays the room's `!bj` commands; room players and web players sit
  at the same table. A table opened with `!bj start` in a flagged room is pushed to that room from the start.
- **Telegram:** gambling stays excluded (the user's rule for the bridge). The bot act endpoint refuses
  `channel: "telegram"`, and the Telegram allow-list never gets `!bj`.

### Why in the site and not a separate service

- The ledger (users.points_balance + transactions), the House (`jackpot_rakes`), the flash claims (`reserve_claims`)
  and the casino ban all live in the site's SQLite file. In the site process a settle is local function calls on one
  connection; a separate service would need a new money API with its own auth, retries and idempotency on both sides,
  and a second writer on the SQLite file.
- The web UI is served by the site already, with the session, the user's balance and roles at hand.
- The engine is written as a pure module (state in, action in, state + events out; no I/O), the shape the v2 games
  service uses (ARCHITECTURE section 8). Moving it into the v2 games service later is a lift, not a rewrite.

v2 note: v2 standardises engines on Python. The JS engine here is a straight port of `blackjack_engine.py` with the
same tests; when v2's games service lands, either it runs this module (Node) or the Python engine comes back with the
same test vectors (section 12, decision D5).

## 3. Transport between Pepe and the backend

**HTTP long-poll with a cursor, plus a plain HTTP act call.** No websocket.

- `POST /api/casino/bot/poll {password, after, wait, rooms}` returns `{cursor, events[], tables{}}`. The site holds the
  request up to `wait` seconds (max 8) until an event newer than `after` exists. `rooms` is Pepe's heartbeat: the rooms
  he is in with the backend flag on (id + name), which are the rooms a web table can be pushed to.
- `POST /api/casino/bot/act {password, room|table, username, camfrog, name, verb, args, idem, channel}` runs one
  command for a room player and returns `{ok, reply, private}` (the text Pepe @-replies or PMs).
- Auth: the existing bot token (`isBotToken`, the body `password`), as every other Pepe route.

Why not a websocket: the site has no websocket dependency today, Cloudflare and the staging router
(`camfrog-bot/staging.py`, 10-15 s timeouts, POST pass-through) already handle these request shapes, and the cursor
makes it resumable: after a Pepe restart he asks for `after=<saved cursor>` and gets what he missed (events are kept
48 h). Latency: an event reaches Pepe within one round trip of being made (the poll is waiting), so click-to-chat
is ~0.1-0.3 s instead of today's 1-2.5 s. POST, not GET: the staging router sends GETs to the prod site when the
staging site is down; a POST falls back to the sandbox, which answers an empty poll.

Pepe's side never blocks a packet handler (memory: pepe-chat-lag): commands go onto one ordered worker thread
(`pepe-casino`), the poll runs on its own thread, and chat output goes through `send_chat(room=...)`.

## 4. State model and persistence

Tables (`casino_tables`): `id`, `game`, `status` (open/closed), `room` (pushed-to room id or null), `host`, `state`
(JSON), `rev` (bumped on every change), `created`, `updated`. The whole engine state is a plain JSON object (shoe,
cards, bets, hands, seats, timers' deadlines, autobet, pending bets, strikes), so the row IS the table: a restart
loads it and carries on. The secret server seed of the round in play sits in the row and never in a view.

Events (`casino_events`): `seq` (autoincrement = the cursor), `table_id`, `room`, `ts`, `kind`, `data` (JSON with a
ready chat `text`). Public only. Pruned after 48 h.

Rounds (`casino_rounds`): one row per round with the commitment at betting open, then the seed, client seed, the
shoe and the results at settle (the audit trail and the fairness page).

Actions (`casino_actions`): `key` (idempotency key) -> stored response. A repeated key returns the stored answer and
does nothing.

**Every PAT movement has a deterministic key** `cbj:<table>:r<round>:<user>:<op>` (op = bet, dbl<n>, spl<n>, ins,
pay, plus `house+` / `house-` per round). The key is the `transactions.transactionId` for a player movement and the
`jackpot_rakes.jackpotId` for a House movement, so a movement is done once whatever happens: before moving, the
service checks the key; a retry finds it and skips.

**Order of a money step** (bet, double, split, insurance): write the intent into the table state and save, move the
money by key, apply the action, save. A crash in between leaves an intent with or without its movement; recovery
looks the key up: charged -> refunded with `<key>:refund` (the player can act again), not charged -> dropped. Nobody
loses a stake to a crash and nothing is charged twice.

**Settle** is: the engine computes the results (state saved with `settle: "pending"`), then the payouts, the House
rows and the flash claim, each by key, then `settle: "done"` and the events. Recovery re-runs a pending settle; the
steps already done are skipped by key. **A hand in progress survives a restart**: the table is reloaded, the deadline
of the current decision is re-armed (if it passed while the site was down, the player gets a fresh 30 s rather than
an instant time-out), and play continues.

Concurrency: one async mutex serialises every casino mutation (all tables). There's no `BEGIN ... COMMIT`: the site
shares one SQLite connection between requests, so a rollback could undo someone else's write; idempotent keyed steps
replace it.

## 5. Timers

One 250 ms service tick checks every open table's deadlines (betting window, insurance window, decision, idle), so
there is no per-table `setTimeout` to lose on restart. Values are today's (section 1). Deadlines are absolute
timestamps in the state, shown on the page as countdowns. A decision that runs out stands the hand (AFK strikes as
today). Restart grace: deadlines that passed while the process was down are pushed to now + their full length.

## 6. Fairness

Commit / reveal with a client seed, the v2 standard (ARCHITECTURE 6.4: "server seed hash when it opens, the seed when
it closes; reproducible from server seed, client seed, nonce"):

- at **betting open** each round gets `server_seed` (32 random bytes) and publishes `commitment = sha256(server_seed)`
  before anyone bets (today: at the deal);
- `client_seed` is per table (random at open, shown on the page; a later option lets players set it, D6);
- the shoe = Fisher-Yates over 6 decks driven by `HMAC-SHA256(server_seed, client_seed:round:counter)` (32-bit words,
  rejection sampling, no modulo bias);
- after the round the seed is revealed (event + `casino_rounds`), and `/casino/fair/<table>/<round>` re-derives the
  shoe and checks the commitment (server side and in the browser, WebCrypto);
- the old Camfrog engine keeps its own scheme and `blackjack_fairness.jsonl` until it is retired.

## 7. Limits and roles

- Table: 6 seats, bets 100-10,000, 6 decks; the **High Roller** role (`user_roles.role = 'high roller'`) has no
  maximum, as today. Max open tables: 4 (setting). One table per room.
- Hold'em (phase 2): today's caps, and High Rollers may open bigger tables (higher blind caps and up to 9 seats,
  D8).
- Casino ban (`users.casino_banned`) blocks every money action, web and room.

## 8. House bankroll, flash liquidity, routing

- Stakes leave the player at bet / double / split / insurance (`ledger.post`, requireCover: never overdrawn).
- Cover rule (today's): a stake is refused if the House couldn't pay the round: `House / 2 - staked in this round`.
- Settle per player: the full payout is credited (one keyed transaction, type `blackjack payout`). Per round: the
  lost stakes go INTO the House (`jackpot_rakes +lost`, key `...:house+`), the winners' profit comes OUT of it
  (`jackpot_rakes -profit`, `...:house-`). Pushes and returned stakes never touch the House.
- Before the profit leaves the House: `funding.houseFlashCover("blackjack", profit, ...)` books a
  `flash:house:blackjack` claim when the House would drop below its hard floor and the Fed has loan room; Pepe settles
  it into a Fed flash loan, as for the wheel and the Discord blackjack. Players are never stiffed: if no flash is
  possible the payout still happens and an `uncovered` line is logged (same as Pepe today).
- Routing: losses -> House 100%. Hold'em rake (phase 2) -> House 100%. `jackpotflows.js` reports `cbj:` rows as
  "casino tables".
- Sourced credits: payouts are House payouts by construction (the `house-` row is the source); refunds return the
  player's own stake (`<key>:refund`), never new money.

## 9. Anti-abuse

- One seat per account per table (the seat key is the PATV userId, the same for web and room).
- Accounts linked as duplicates (`welcome_bonus.dup_of`) can't sit at the same table.
- Web seats record a hash of the client IP; two different accounts from one IP at one table are logged as a
  `multi` flag on the table (not blocked: households share IPs; the admin page lists them).
- Blackjack is player vs House, so collusion has little to gain (no transfers between players). Hold'em (phase 2)
  needs: no two dup-linked or same-IP accounts at one table, chip-dump detection (heads-up folds to one player
  repeatedly, abnormal fold-to-raise between a pair), and the rake.
- Per-user act rate limit (10/s burst) and the idempotency keys.

## 10. Migration and feature flags

- **Site flag** `casino_settings.bj_enabled`: the service and `/casino/blackjack` exist only while it is on. Default:
  on for staging (`STAGING` env), off for prod. `tools/casino-settings.js get|set` changes it (applied within 10 s).
- **Pepe per-room flag** `!casino backend on|off` (admin, in the room): the room's `!bj` and the bare blackjack verbs
  (`!hit !stand !double !split !insurance !autobet`, and `!bet !leave !sit` while no hold'em table is open in the room)
  go to the backend. Default off everywhere: the old engine stays the default until parity is signed off.
- **No in-flight game is lost:** the per-room flag refuses to switch while a local blackjack table is open in that
  room; the old engine keeps its escrow recovery for its own tables.
- Rollout: staging rooms on -> parity checks -> prod with the site flag on and one room on -> all rooms -> retire the
  old engine and `/api/tables/*` for blackjack.

## 11. Ledger and economy requirements (from the v2 docs)

- R: every credit names its source pool (the House) and is idempotent by key: done.
- R: no mint, no burn: stakes go to the House or back to the player; the profit comes from the House; the House's
  shortfall is a Fed flash loan.
- R: per-channel idempotency keys: web `web-<uuid>`, Pepe `cf-<uuid>`; replays are answered from `casino_actions`.
- R: audit trail: `casino_rounds` (who, bets, cards, outcomes, payouts, fairness) for the site's history and later v2
  import into `table_session` contracts.

## 12. Proper frontends (later phase, after the backend; added 2026-10-11)

The user wants real Hold'em and Blackjack frontends on the site, with their own design pass once the backend is
ready. Phase 1's `/casino/blackjack` page is a functional test page, not that design. The API and state model are
built to carry a rich UI:

- **Seats:** a stable seat id per player (`seat`, a salted hash, never the userId), name, where they play from
  (`via`: web / room), host flag, bet, queued bet, autobet, insured, leaving, every hand (cards, value, soft,
  bet, doubled, split, outcome, payout, current). Phase 2 adds a fixed seat index (seat position at the felt), so
  a UI can draw seats round an oval without them moving when someone leaves.
- **Avatars:** the view adds each seat's PATV avatar URL and its GTF cosmetic look (the overlay already wears
  them via `_cos_enrich`), served by the same public view. No private data.
- **Chips:** amounts are integers in every field. The UI chooses chip denominations; the events carry each
  movement (bet placed, double, split, insurance, payout, the House's take), so chips can fly to and from the
  rack.
- **Timers:** every deadline is an absolute server timestamp (`bet_deadline`, `ins_deadline`, `turn.deadline`)
  plus `now` in each response, so countdown rings stay in sync with the server's clock.
- **Animations:** an ordered event stream per table (`casino_events`, the same one Pepe reads) with typed events
  (deal, prompt, acted with the card drawn, dealer reveal and draws, settle with per-hand outcomes). Phase 2 opens
  it to web clients: `GET /api/casino/bj/t/:id/events?after=<seq>` (long-poll, or SSE), so the page animates each
  card in order instead of diffing snapshots. Snapshots stay for the first load and for reconnects.
- **Spectators:** anyone, signed in or not, can open a table and watch (the public view hides the dealer's hole
  card and, in Hold'em, every hole card). A spectator count per table is kept from the poll / stream connections.
- **Hand history:** `casino_rounds` holds every round: players, bets, cards, outcomes, payouts and the fairness
  proof. Phase 2 adds `/casino/history` (your own rounds, and a table's last rounds) and per-round replay from the
  stored shoe.
- **Hold'em specifics:** the public view never carries hole cards. Each seated player's own cards come from a
  per-user endpoint (or the per-user part of the stream), never stored in an event that anyone else can read.
  Showdown reveals are public events.

**Built 2026-10-11 (D10, the design pass):** `/casino/blackjack` and `/casino/holdem` share a lobby (both games' open
tables: seats taken, stakes, the room each is pushed to, stream, latest proof; Join / Watch / Open a table with the blinds
picker) and a look (views/partials/casino-*.ejs, public/js/casino-ui.js). Blackjack: a felt with Pepe and six seats on the
arc, chip-button betting (100 / 500 / 1K / 5K / max, High Rollers uncapped), hit / stand / double / split / insurance only when
legal, countdown rings on the server deadlines, deal / flip animations from a diff of the cards, the dealer's reveal and
payout pops. Hold'em: an oval with nine seats (you at the bottom), button and blinds, bets in front of the seats, the pot as
one total plus "not called yet" mid-street and main / side pots once chips are in the middle, your hole cards only from
`me`, fold / check / call / bet-raise with a slider and min / half pot / pot / all-in presets, the buy-in / top-up sheet, the
showdown reveal. Both: history sheet (`GET /api/casino/t/:id/history`, revealed rounds only, with the rake), spectator
ribbon + count, host tools (push to a room, Pepe's stream with the queue position and the admin override), a sticky thumb
bar on phones, reduced motion, strings in locales/en.json. Read-only API additions only; the engines and money are unchanged.

## 13. Pepe's stream: pushing a table to the OBS overlay (added and built 2026-10-11)

When a table is pushed to a room, the host (or an admin) can also ask for it on **Pepe's stream**: the OBS games
overlay, `pepe-avatar.html?view=games` (the game-board channel of `avatar_server.py`; the face stays on
`?view=pepe`).

- **One table on the stream at a time.** The stream slot is a single site-side record
  (`casino_settings.stream_table` + who took it and when), changed only under the service mutex.
- **Who gets it: first come, admin override, a queue.** A request while the slot is free takes it. While it's
  taken, a host's request joins a FIFO queue (shown on the page: "you're 2nd for the stream") and gets a clear
  answer ("the stream is showing <host>'s table; you're queued"). An admin can override: take the slot for
  another table at once (the bumped table goes back to the head of the queue). The slot is released when its
  table closes, is un-pushed, or is idle for 5 minutes with no round dealt; the next queued table then takes it
  and Pepe announces it in that room.
- **Other Pepe overlay games** (Pictionary, heists, bingo, old-engine Hold'em or Blackjack) keep their
  priority: while one owns the board, a backend table waits (its slot is held, nothing is drawn) and appears when
  the board is free. Pepe's `_avatar_emit` gating already does this per game. Pepe draws the board from the
  table's public view, which the poll already returns (`tables`), as phase 1 does for one table.
- **Prod only in practice:** only the prod VM runs OBS; on staging the slot logic is testable, the board isn't.

Built 2026-10-11 with Hold'em: `casino_settings.stream_slot` {table, queue}, `POST /api/casino/t/:id/stream {on, override}`,
the poll's `stream` field; Pepe draws only that table's board (blackjack or poker).

## 14. Hold'em (phase 2, built 2026-10-11)

- **Engine** `casino/hmengine.js`: a port of `poker_engine.py` (evaluation, side pots, the betting machine, the 2%
  showdown rake, error texts). 250 tables recorded from the Python engine replay identically (every event, stack and
  error, 400 showdowns, 159 with side pots). The deck is one committed fair shuffle per hand (fair.js, 1 deck); the
  PokerNow-style per-board reshuffle isn't needed when the whole deck is committed before the deal.
- **Table session escrow** (`casino/holdem.js`): `!sit` charges the buy-in (PAT -> chips, keyed `chm:<t>:<uid>:buy:<n>`),
  standing, busting, the idle close and closing the table pay the stack back (`...:out:<n>`). Both are journalled as an
  intent first: an interrupted buy-in is refunded at restart, an interrupted cash-out is finished (paid once). Within
  a hand only chips move. The rake goes to the House by key (`chm:<t>:h<n>:rake`).
- **Private hole cards**: never in the public view, never in an event, never in a page's HTML. The web gets its own
  cards in `me.cards`; Pepe's poll gets the room players' cards in a bot-only `private` part (by Camfrog name) and
  PMs them once per hand; `!cards` answers privately. Showdown reveals are public.
- **Rules / timers** = Pepe's !holdem: 60 s to act (time-out = check, or fold and sit out after the hand), 15 s
  between hands, 300 s idle close, 9 seats, buy-in 20-200 BB, blinds up to 5,000/10,000, host handover. Changes:
  a stand during a hand (also after folding) is queued until the hand ends (the old engine let a folded player leave
  mid-hand, which could drop the button), and a top-up waits until the hand is over.
- **High Rollers** (D8): open tables above the blind caps and buy in over the maximum.
- **Anti-collusion basics**: dup-linked accounts or two accounts from one address can't sit at one table; a player who
  folds to the same opponent 5+ times with 50+ BB put in is flagged on the table (`multi`, logged).
- **Fairness**: the next hand's seed is committed when the table opens / the last hand ends; each hand's proof is
  linked in chat when it ends (`/casino/fair/<table>/<hand>`), `!holdem fair` repeats it.
- **Pepe**: `!holdem` and `!check !call !fold !raise !allin !sit !cards` in a backend room; `!bet !stand !leave` go to
  the room's table, whichever game. Overlay: the poker board for the table on the stream.
- Page `/casino/holdem` (functional; the design pass comes with D10).

## 15. Decisions (the user, 2026-10-11)

- D1. Prod: ship the code DARK (site flags off, every room off); the user promotes the batches.
- D2. Hold'em follows this design (built: section 14).
- D3. Keep the Discord blackjack for now; later move it onto this backend (one engine).
- D4. Web-only players get achievements and drops on the website - built 1.99mj (`casino/rewards.js`): the site counts a seat
  unless the table is in a Camfrog room AND the seat has a Camfrog name (Pepe counts those; the events name a seat's
  Camfrog name only then, so nobody is counted twice). Same metrics (bj_hands, bj_naturals, holdem_pots) in
  `casino_ach_counts`, the same cf_bj_* / cf_holdem_* badges via `achievements.awardCount` (XP, PAT, Pepe's feed), the same
  drops and gates as Pepe (natural on a bet >= 2,500 scaled by bet / max; showdown pot >= 20,000 against someone else, not
  linked, both level 2+, 3 rolls per pair a day; organic daily cap), keyed per round so a re-run never counts twice. Pepe
  pushes the blackjack / hold'em rows and gates with the wheel's (`/api/cosmetics/drop-config` rates + params).
  Known edge: progress isn't merged when a web-only player later links Camfrog (Pepe's counters start at 0 for them).
  **1.99mw: the site awards EVERY seat** (web or Camfrog, room table or web table) - achievements, drops, win XP and gang
  rep - and Pepe awards nothing for a backend hand (the settle / win / awards events carry no Camfrog names any more; an
  old Pepe therefore stops on his own). Achievement thresholds use Pepe's count so far as a base: the bot poll answers
  `ach_want` (Camfrog names of seated players with no base or one older than an hour) and Pepe sends `ach_base`
  (`casino_ach_base`, replaced each time); a base never awards by itself. Win XP = Pepe's _grant_xp rate (0.005) on the
  net win (blackjack round profit; hold'em chips won - chips put in), once per round/hand + seat. Gang rep stays in Pepe
  (gangs.json): the site queues one rep event per win for the seat's Camfrog name (or the account's linked one) in
  `casino_rep_queue`, the bot poll hands out unacked ones as `rep`, Pepe applies each key once (_gang_add_rep, a
  persisted done-list) and acks it in `rep_ack`. Hold'em PvP drop pairs are counted on the site only (`casino_pvp_rolls`),
  not shared with Pepe's duel/brawl pair log. No backfill.
  **1.99nc:** the same counter (\`rewards.siteCount\`) awards the lotto and market win achievements by ACCOUNT: cf_lotto_win /
  cf_lotto_jackpot for every paid lotto winner (lotto/service.js; Pepe 1.99nd stops bumping lotto_wins / lotto_jackpots),
  lotto_tickets for buyers with no Camfrog link (Pepe still counts linked buyers from the sale event - disjoint), cf_market
  on the market-win payout itself (/api/wager/payout, keyed by Pepe's idempotency key; Pepe stops counting market_wins by
  name, which mis-resolved web-only names). All threshold-1 badges except cf_lotto_100; a badge is only ever given once.
  **1.99pa: hand achievements** (`casino/achhands.js`, pure; Pepe's `pepe_casinoach.py` mirrors it for his own tables): at a
  hold'em SHOWDOWN (holdem.js calls `rewards.holdemShowdown` with T.sd + the awards) - full house / quads / straight flush /
  royal flush won when the hole cards make it, 7-2 offsuit, 1M+ pots, all-in wins, knock-outs (not of your own alt), bad beats
  (lost holding quads+, or as an 85%+ favourite on the turn), High Roller table wins; `holdem_hands` per seat that put chips
  in. Blackjack per seat: Five-Card Charlie, doubled wins, split sweeps, insurance paid, a High Roller's uncapped win, the
  win / dealer-bust streaks (`bj_streak_run` / `bj_dbust_run` rows, set not added). Each step keyed by table + hand/round +
  seat + metric. New Pepe bases: holdem_hands, bj_double_wins, hm_busts. `rewards.quietBackfill()` (achievement_meta
  'casino_ach_backfill_oq') gives the new thresholds on counts the site already had, badge only, before any new hand can.
- D5. Keep the JS engines for v2, with the shared Python test vectors.
- D6. Client seeds later; a short fairness link in chat after each round, and on request (`!bj fair`, `!holdem fair`) - built.
- D7. One table per room (either game), NO site-wide limit (`max_tables` 0 = none) - built.
- D8. High Roller Hold'em: bigger tables (above the blind caps) and bigger buy-ins - built.
- D9. Stream slot: first come, FIFO queue, admin override, 5-minute idle release - built (section 13).
- D10. The frontend design pass comes after Hold'em lands, both tables together.
- Added: a table opening in a room links its web page in Pepe's announcement (both games) - built.

## 16. Decisions that were open (kept for the record)


- D1. Prod rollout: turn the site flag on in prod and the per-room flag in which rooms, when.
- D2. Hold'em (phase 2) on this design? Its extra parts: private hole cards per seat (served only to the owner, never
  in events), buy-in/cash-out as a table session escrow, the side-pot engine, rake, the anti-collusion rules above.
- D3. Retire the Discord blackjack (`/api/blackjack/wager|result`) in favour of this service, or keep it.
- D4. Achievements / cosmetic drops for web-only players with no Camfrog link (today they are Camfrog counters).
- D5. v2: keep the JS engine in the v2 games service, or port back to Python with the shared test vectors.
- D6. Player-chosen client seeds and showing the fairness proof in chat (today it is only on the site).
- D7. Tables per room and max open tables (1 and 4 in phase 1).
- D8. High Roller hold'em perks: blind caps and seat count.
- D9. The stream slot rule (section 13): first come + FIFO queue + admin override, idle release after 5 minutes:
  confirm, or prefer refusal with no queue.
- D10. Frontend design pass (section 12): when, and whether Hold'em's frontend waits for the Hold'em backend.
