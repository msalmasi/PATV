# Casino backend: blackjack and hold'em on the site

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
- D4. Web-only players get achievements and drops on the website (not built yet: the site needs its own counters).
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
