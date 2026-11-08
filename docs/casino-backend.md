# Casino backend: blackjack and hold'em on the site

## Sit & Go tournaments (handoff 22, phase 1)

A sit & go is one Hold'em table (`casino/holdem.js`, game `"holdem"`) with a `tourney` block; `casino/tourney.js` owns that block
and is installed on the same core as Hold'em (`casino/service.js` `TN`). The table page, the action bar, pre-moves, sizing, the
60 s clock + time bank, the stream slot, Pepe's poll / OBS board, the veil masks and the per-hand fairness proofs all work as
at a cash table. Phase 2 (scheduled multi-table tournaments, late registration, guarantees after H2b) is not built.

**Switch.** `casino_settings.casino_sng` = `off` (default) | `staff` (class Staff and up, or `casino.admin`) | `everyone`.
Hold'em on the site (`hm_enabled`) must be on too. The switch gates creating and registering, and while it's off (or `staff`,
for a member) `!sng` / `!sng help` / `!sng info` answer "switched off" / "staff only" - an entrant still sees the ones they're in.
Leaving a registering sit & go (a full refund), playing one that started and an admin's cancel always work. The web lobby
(`/casino/holdem`) follows the Hold'em front end: while `hm_front` is `pepe` it redirects to Pepe's tables, so the Sit & Go
section and its Create sheet aren't reachable there (the admin card says so); a sit & go's own table page always opens.

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
is called off (full refunds) 60 minutes after it opened - unless a "start at N" countdown is running then (N are in): that
countdown runs out and it starts - at most 3 not-started sit & gos per account, a finished one's results stay in the lobby /
on its page for 15 minutes. A create by the same account for the same sit & go (seats, buy-in, turbo, start at) within 2
minutes of opening one (`DUP_MS`: its reply lost to a restart, a double click under a new key) answers with that one - never a
second sit & go or a second hold.

**Shape.** The creator picks the seats, a buy-in from the list, turbo, and optionally "start at N" (2 <= N < seats); the
creator is registered. Registration uses the cash tables' entry rule (`holdem.js seatChecks` over everyone registered):
an account, no casino ban, no dup-linked account, no second account from the same address. It starts when full, or when
the countdown runs out with N or more in (the countdown stops when a leave takes it below N). Seats follow registration
order; the first seat has the first button. No late registration, rebuys, add-ons or antes.

At its table the bare Hold'em verbs mean the sit & go's: `!sit` / `!buyin` / `!join` register (an amount that isn't the buy-in
or the whole entry - `!sit 2000` out of cash-table habit - is refused with the entry), `!stand` / `!leave` unregister until it
starts, `!holdem status` / `help` are its info / help, `!holdem start` in its room points at it. A registration's reply is
never quiet (the room's line doesn't say what was held).

**Play.** Rake 0 (the engine's `rake` is 0 at a tournament table). The level's blinds are set just before each hand
(`beforeHand`), never mid-hand; the level clock is absolute while the site runs. Sitting out = blinded away: a seat sitting out
when a hand is dealt (`tourney.hand_start.out`) is dealt in and checks / folds at once (no 60 s wait). `!sitout` during a hand
starts with the next one (that hand is still the player's, as the button says); two timeouts in a row sit a seat out at once
for the rest of the hand too; a seat that is out never spends its time bank (its 60 s run out, then a check / fold). When the
button busts, the button goes back to the nearest seat still in before it, so the next hand moves it on clockwise (the
engine would give a stood-up button to the first seat). No sit-out limit, no idle close, no stand / cash-out / host close: the cash
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

The PAT supply (`supply.js casinoHeld`) never counts a sit & go's tournament chips: its PAT is the entries' `TNY` holds, counted
with the escrow. Every PAT move is ONE `dbUtils.tx`: the escrow leg (`escrow/ledger.js` in-transaction primitives), its `escrow_moves` journal
row (`seen` / `record` under the key below) and the table's saved state (`service.save` -> `casino_tables`) commit or roll back
together. A refused move changes nothing (the in-memory table is restored from a snapshot). Hold kind `TNY` (ref
`TNY-<table>`) is in `SERVICE_KINDS`: never in Pepe's mirror, never handed back by a rollback, his keyed calls can't move it.

| step | key | legs | a restart / retry |
|---|---|---|---|
| register | `tny:<table>:<user>:enter:<n>` (n = that account's nth registration here) | wallet -> hold (buy-in + fee, `requireCover`: refused with nothing held when the wallet can't cover it; refused for a casino ban) | the entrant and the hold commit together: either both are there or neither; a retry of the same request is answered from `casino_actions`; registering again after leaving is a new n |
| unregister (before the start) | `tny:<table>:<user>:refund:<n>` | hold -> wallet, in full (fee too) | `seen` = already refunded: the state is fixed up, nothing moves twice |
| start | - | none (tournament chips only) | a full field saved as registering is started by `recover`; a countdown / the registration hour keep the time they had left at the last save |
| a hand | - | none | mid-hand: the hand resumes (fresh clock for the actor); the running level keeps the time it had left at the last save (the clock pauses while the site is down); a hand that ended before its bust-outs were placed is placed again from the saved start stacks (places are idempotent). A hand whose wrap-up threw part-way (a failed write after its proof: running, between hands, nothing scheduled or one stack left) is wrapped up again by the tick (`holdem.js wrapUp`, once a minute while it keeps failing) - with or without a restart |
| finish | `tny:<table>:finish` | ONE `settleInTx`: every entry hold spent; payouts to the placed accounts; fee leg `["jackpot", fee x entrants]` = a `jackpot_rakes` row `esc-tny:<table>:finish-0` (spinId `escrow:TNY-<table>`) | the places + `status: "settling"` + the plan are saved first; `recover` / the tick re-run the settle; `seen` = paid: only marked finished. The settle runs only if prizes + fee == held (it never leaves a "kept" rest) |
| cancel (admin) / the hour's call-off | per entrant `tny:<table>:<user>:refund:<n>`, then `tny:<table>:cancel` | each hold -> wallet in full (fee too) | refused once `tny:<table>:finish` is seen (paid out); per-hold keys skip what's done |

Conservation (test/casino-sng.test.js, 6 players at 1K): wallets + House + held = 11,100,000 before, after registration
(wallets -6,600, held +6,600) and after the finish (wallets -600, House +600, held 0); 1st 3,900, 2nd 2,100, fee 600.

### The contract (web + Pepe)

- `GET /api/casino/t/:id` -> `table.tourney` (names only, masked by the table's veil; no account or hold ids): `{id, short, status:
  registering|running|settling|finished|cancelled, size, field, start_at, turbo, buyin, fee, entry, stack, level_mins, registered,
  entrants: [{name}], countdown_at, expires_at, level (1-based), sb, bb, next_sb, next_bb, level_ends_at (ms), level_secs_left,
  countdown_secs_left (the countdown in seconds on the site's clock, or null), players_left, pool, fee_total, prizes: [PAT by place],
  places: [{place, name, prize, tied}], cancelled: null|cancelled|expired|empty}`; `me.tourney` = `{registered, can_register, place,
  prize}` (`can_register`: the page offers Register only then - the switch, staff only, a casino ban; the entry rule decides at the click).
- `GET /api/casino/sng` and `GET /api/casino/lobby` -> `sng`: `{on, audience, can_create, sizes, buyins, fee_pct, payouts, level_mins,
  turbo_mins, stack, countdown_secs, reg_mins, list: [row]}`; a row = `{id, short, url, host, status, size, field, registered, start_at,
  turbo, buyin, fee, entry, stack, level_mins, countdown_at, expires_at, level, sb, bb, players_left, prizes, winner, me, rooms, on_stream}`.
  Sit & gos are not in the cash lobby's `tables` nor in the poll's `open`. The lobby's Register / Create follow `can_create`.
- `POST /api/casino/sng/new {size, buyin, turbo, start_at, idem}`, `POST /api/casino/sng/:id/register|unregister {idem}`,
  `POST /api/casino/sng/:id/cancel {idem, reason}` (casino.admin, in the admin log as `casino_sng_cancel`) - JSON + `X-Requested-With: fetch`.
- Pepe: `POST /api/casino/bot/act` with `game: "sng"` and `verb` `""`/`list` | `new` (args `[seats, buy-in, "turbo"?, "at", N]`, up to 5) |
  `join` / `leave` / `info` (`[id-or-prefix?]`; no id = the room's sit & go, else the only one that fits) | `cancel` (`[id, reason?]`,
  the PATV account needs `casino.admin` - Pepe's `admin` flag is not enough) | `help`. `BOT_VERBS` has them. At a sit & go's table the
  bare Hold'em verbs work as at a cash table; `!sit` / `!join` register and `!stand` / `!leave` unregister while it registers, and are
  refused once it runs. The poll adds `sng` (the open rows), `sng_on` (the switch: `off` | `staff` | `everyone`; `off` while Hold'em is
  off - Pepe sends `!sng` only to a site whose poll has `sng`) and each sit & go table in `tables` carries `tourney`. Events: `opened`,
  `line` (registrations, countdown, "Blinds up"), `sng` (`data.sng`: start / bust / won / finished / cancelled), `closed`.

## Scheduled tournaments (MTT) (handoff 22, phase 2)

Built on top of the Sit & Go: the same money rules (the brief's decisions 1-11), the same engine (`casino/hmengine.js`, unchanged; its
250 vectors pass) and the same table code. `casino/mtt.js` is the service; `casino/mttseat.js` (the draw, the blind planner, the table
rules) and `casino/mttpay.js` (the curve, places, ties, points, the estimate) are pure; `casino/mttbudget.js` is the only module that touches
the budget service. Everything ships dark behind `casino_mtt` (`off` | `staff` | `everyone`, default `off`); Hold'em on the site
(`hm_enabled`) must be on too. PAT is points.

**The table theme (hand-off 20's themes, site 1.99amf).** A tournament table is classic, exactly like a Sit & Go table: the themes brief
keeps tournaments out of its scope, and hand-off 20's rebase made a Sit & Go table classic (built with no theme). `newTableInTx` builds an
MTT table the same way (`HM.newTable(..., { tourney: true })`, no `opts.theme`), so `T.theme` is `classic` at every `casino_themes` value,
and publicView, the table API, Pepe's board (the bot poll's `tables`), the table page's theme files and `casinohm.js` (the one `CZ.theme`
call in render, after the header) treat it as they treat a Sit & Go table - no tournament branch of their own; no dealer flavour line.
`test/casino-mtt-theme.test.js`.

**The switch.** `staff` = phase 1's predicate (`siteperms.atLeast(u, "staff") || can(u, "casino.admin")`). Whoever the switch excludes gets
no new registration or re-entry and "Tournaments aren't open yet."; the pages answer 302 to `/casino/holdem`. Anyone with an ACTIVE entry
(held / playing, or a result under 15 minutes old) keeps the tournament page, `/me`, Unregister (while registering), the table link and
`!mtt me|leave|info`. Off: a scheduled one never opens registration (cancelled at its start, nothing held); a registering one is cancelled
at its start with full refunds ("tournaments are switched off"); a running one plays to the end (PAT is never stranded).

### Lifecycle

`scheduled` -> (reg_opens_at; the switch allows; a guaranteed one also needs the create gate: the structure + money are FROZEN, the draw
seed made and its sha256 published) -> `registering` -> (start_at, at least min entries) -> `running` -> (the bust that leaves one player:
set in that bust's transaction) -> `finishing` -> (the ONE escrow settle) -> `settled` -> (the guaranteed part paid | owed | none, the post
steps done) -> `done`. Fewer than min at the start, the switch off, or an admin = `cancelled` (every entry refunded, the fee too). In
`finishing` only the owner's "void and refund" cancels, and never once `tny:<id>:finish` is seen; a cancel is refused once the finish is
seen and the finish once the cancel is - the mutex orders them. Pause / resume keep `running` (the clock stops and moves on by the pause).

Every transition is ONE `dbUtils.tx` with its effects, under the casino mutex. A mutation snapshots M and every table it touches first; if
the transaction throws, each is restored by FULL replacement (the same objects stay in `S.mtts` / `S.tables`) and a table made in it never
reaches `S.tables`. Kicks, lines, notices and the stream only happen after the commit, each in its own try/catch.

**Schedule (admins: `casino.admin`, every action audited as `casino_mtt_<action>`).** `/admin/casino/mtt`: title, the start in ET (10
minutes to 30 days ahead), when registration opens (default 24 h before), the buy-in from `mtt_buyins` (0 = a freeroll, only past the create
gate), standard / turbo, starting chips, 6- or 9-handed, max / min entries, late registration (levels), re-entries (0..`mtt_reentry_cap`),
a guarantee (create gate), up to 6 announcement rooms, and a daily / weekly series (1-8, kept at the same ET wall time across DST; the
instances are validated one after another, each counting the earlier ones). Caps: `mtt_max_running` tournaments whose play windows
`[start, start + min(12 h, 1.5 x estimate)]` overlap, `mtt_max_open_reg` registering at once (a later one waits as scheduled). The estimate:
the first level whose big blind is at least the chips in play / 20 (180 x 1,500 = 18 levels). An on-air booking in the final-table window is
a warning only. While registering: the title, the rooms, raise max entries, delay the start (6 h in all; reminders re-dated). The manager's
Edit fills the whole form from the tournament; once registration is open only the title and the rooms are sent (the rest is disabled), and
the server never lets a blank field replace a stored value.

**Registration** (`POST /api/casino/mtt/:id/register`, `!mtt join <no>`) is ONE transaction: the gates in order (the switch, the status,
the escrow live, an account not casino-banned, capacity, already in, the room cap `mtt_room_entrants_max`, the cash tables' anti-collusion
rule over EVERY non-refunded entry of the tournament - so a linked or same-address account can't enter even after the other busted -,
the freeroll rules, a 2-second gap per user), then the hold, the entry row, M, and the answer written to `casino_actions` INSIDE the same
transaction (a committed answer is never lost to a crash). Late registration (while `late_open`) seats the entrant through transit at the
table with the fewest players (ties: the lowest number); when all are full a breaking table with room is un-marked, else a new table opens.
Late registration closes at the first of: level >= `late_levels` (by the clock - also for a request that arrives before any tick), max
entries, or live players <= paid(E) + 1. Then E (the entries that count, re-entries included) and the curve are fixed. Re-entry: only after
busting, only while late registration is open, at most `reentry_max` (refunded pre-start entries never count).

### The router + the boundary pipeline

`service.js` builds ROUTE (`tny: () => ROUTE` for holdem.js); each method dispatches on `T.tourney.kind` - a missing kind is "sng", so every
row written before phase 2 stays a Sit & Go. holdem.js has three narrow hooks: `beforeDeal` at the top of beginHand (an MTT table runs its
boundary even with 0-1 players), `dealt` right after `H.startHand` (the hand's start record), and `noDealNext` after a failed deal (an MTT
table: what its boundary scheduled, else a 10-second safety re-check). MTT tables are hidden from the cash lobby, `openList` and the Sit & Go
lists, refuse push / advertise / a host's stream (only an admin's override), have no room, refuse the host verbs, aren't counted by
`max_tables`, earn no casino hand rewards (hmRewards), and their events (no room) are only in the table's own log (no `casino_events` row).

The boundary (`beforeDeal`), every hand at every table: the level clock (`advanceClock`, one clock for the whole tournament; a hand in
progress keeps its blinds); held `stopped` / `pause`; (1) a queued disqualification for a seat here; (2) the final table; (3) breaking and
(4) balancing (not during hand-for-hand); (5) hand-for-hand; (6) arrivals + the blind plan; (7) the clock's blinds; (8) fewer than two
players = hold `wait`; (9) chip conservation (sum of every live table's stacks + pots in play + transit = total chips; a violation pauses it
by the system with an opsalert - chips are never guessed); (10) the start record (pre-blind stacks) and deal.

**Blind planner** (`mttseat.blindPlan`, proven on JSON copies of the real engine): the big blind always moves forward one seat (the first
player after last hand's big blind, in last hand's order, still at the table); arrivals sit just before that seat - the first arrival is this
hand's big blind, the next one the hand after; heads-up nobody posts the big blind twice in a row; when the small blind would fall on last
hand's small blind it is DEAD (0 that hand; the level's small blind is shown; the button may stay on the same player twice - the standard
compromise). It sets `e.button` so the unchanged engine (which moves the button one seat) posts exactly that. The same planner now runs at a
Sit & Go too (commit "sng: blind planner" - an SNG behaviour change: phase 1 still skipped a big blind when the big or small blind busted,
and gave last hand's big blind the big blind again going heads-up).

**Balancing (TDA).** Only the table at its own boundary gives: while it has the most effective players (seated + inbound transit) and the
tables differ by 2+, the player who would be big blind next (never one who just arrived) moves to the table with the fewest (ties: the
lowest number). **Breaking.** When the live players fit one table fewer (`live <= (k - 1) x size - slack`, slack = `mtt_break_slack` only
while late registration is open), the table with the fewest players (ties: the HIGHEST number; while late registration is open never a
late-registration table opened in the last 2 levels - the start tables are never protected) is marked breaking - no longer a target,
transit to it re-targeted - and broken at its own boundary if the
condition still holds (else un-marked): its players are drawn ("break:<no>:<n>") and each sent to the table with the fewest. **The final
table.** Late registration closed, everyone left fits one table and more than one table is live: every table holds after its hand; when all
are between hands a NEW table is drawn ("final") and the others closed. With one table left (or one table from the start) it becomes the
final table in place, no redraw.

**Hand-for-hand** turns on when late registration is closed, 2+ tables are live and the players left = paid + 1; it turns off at <= paid,
one table, or the final table. Every table holds after its hand; when all are between hands, a round starts: every table deals ONE hand,
and that round's busts share one bust batch (one `bust_seq`), so they place together; hands already running when it turned on bust with
their own batch. The batch is picked by the hand's own round tag, so it is kept when the round's first bust bursts the bubble (and turns
hand-for-hand off): the round's hands still running at the other tables bust into the same batch, ranked by starting stack (ties split) -
never by which table finished first. The round's bust lines wait until every table of the round has finished its hand and go out once,
with the final places. With the curve defaults hand-for-hand only happens when paid >= the
table size (E >= 60 at 9-handed, E >= 40 at 6-handed); otherwise the bubble falls at the final table. Decision 7's clock is unchanged: a
slow table stalls every table during a round (the banner and the admin page name it).

**Presence** (`mtt_presence`, default on): at the start, an entrant who hasn't been seen on the web in 5 minutes (the Hold'em lobby's
Tournaments block, the tournament page / API, a tournament table, registering there) AND hasn't sent a casino command through Pepe in 30
minutes - whichever way they registered - starts sitting out (dealt in, checked / folded at once, blinded away). `!sitin` (or the table
page's sit-in) brings them back; a web entrant who starts out gets an inbox notice saying so (a room entrant: Pepe's start PM). After a
restart everyone counts as present (fail open).

**Moves keep your table life:** the time bank, hands, timeouts and sitting-out travel in the transit record; pre-moves are cleared; a moved
player starts a new seat session at the new table (veil labels never carried across tables). A late entrant or a re-entry gets a fresh bank.

### The payout curve

paid(E): 2-9 entries use the owner's small-field bands (`mtt_payouts_small`, default 100 | 65,35 | 50,30,20); 10+ pay
min(E - 1, max(`mtt_min_paid`, floor(E x `mtt_paid_pct` / 100))) places (defaults max(3, 15 %)), the curve w_i = i^-`mtt_curve_exp`
(0.9) in basis points (floor each, the rest to 1st - non-increasing), fixed as an integer array at late close. Escrow prizes: floor(P x
bp / 10000) each, the rest to 1st, P = buy-in x E (the fees are the House's). At the defaults the smallest paid prize is at least the entry
for every E >= 10. Places come from bust batches: the winner 1st, a later batch higher, within a batch the bigger starting stack higher,
equal = a tie group sharing its places' prizes (unpaid places count 0) - floor each, the odd PAT one each in odd-chip order (the table
number, then the seat order after the button: phase 1's rule across tables). A DQ is its own batch with stack 0 (during a hand-for-hand
round: the round's batch with stack 0, below every bust of the round). Disqualifying is only before the money: a DQ queued during a hand is
re-checked when it applies and dropped once the bubble has burst (casino_mtt_log "dq dropped", an ops alert - pause and decide). A
disqualified player earns no leaderboard points or achievements from that tournament and can't re-enter it. Re-entries rank as their own
entries. E = 27 at 6-handed and 25 %: 6 places, 38.05 / 20.38 / 14.14 / 10.92 / 8.93 / 7.58 %. E = 180 at the defaults: 27 places.

### Money

| step | key | legs | a restart / retry |
|---|---|---|---|
| register / late / re-entry | `tny:<id>:<user>:enter:<gen>` | wallet -> TNY hold (buy-in + fee; refused with nothing held when the wallet can't cover it); a freeroll entry: no hold, no escrow call | the hold, the entry, M and the answer (`casino_actions`) commit together; the same idem replays the answer, a new one says "You're already in." |
| unregister (before the start) / an admin's refund | `tny:<id>:<user>:refund:<gen>` | hold -> wallet in full (fee too) | `seen` + the UNIQUE refund key: a hold is refunded at most once |
| start | - | none (a casino-banned entrant is refunded first) | not committed: the restart starts it (within `mtt_start_grace_mins`, else cancelled "the site was down at the start time"); committed: the tables are released |
| hands, moves, busts, breaks, the final table, a DQ | - | none (tournament chips only) | mid-hand: the hand resumes; a hand that ended before its wrap-up is wrapped up from its SAVED start record (same places; `bust_done` makes a second run a no-op) - also without a restart: a table between hands whose last hand has no `bust_done` (its wrap-up transaction threw) is wrapped up again by the tick before it deals again (at once, then once a minute); a move / break / final not committed changed nothing; committed transit is re-queued and seated once |
| finish | `tny:<id>:finish` | ONE `settleInTx` of every hold: the escrow prizes + ONE fee leg `["jackpot", fee x E]` (a `jackpot_rakes` row, spinId `escrow:TNY-<id>`); `kept === 0` asserted. A freeroll: a journal row only | the plan is checked first (one player left, its chips = the total, every other entry busted, places 1..E, holds = P + F, no cancel seen); any failure settles nothing, retries every minute with an opsalert; the owner's void-and-refund is the way out. `seen` = settled |
| guaranteed part (overlay) | `tny:<id>:overlay` (an owner's retry: `:a<n>`) | the incentive budget -> the winners' wallets through the budget service (`mttbudget.payInTx` -> PO-5 `spendInTx`, inside the MTT's transaction) | after the settle and separate from it; non-terminal (paused, not the site's, headroom, a throw) = pending, retried every 5 minutes under the SAME key; a terminal refusal = owed; 7 days pending = owed; an owner's retry that doesn't pay goes straight back to owed (retry again later, the next `:a<n>`) |
| cancel / void | each `tny:<id>:<user>:refund:<gen>` still held, then `tny:<id>:cancel` | every hold -> its wallet in full | refused once the finish is seen; per-hold keys skip what's done; a hand cut short has its seed revealed |

No `money.house` / `money.credit` / `grantInTx` / `funding.*` / `pools.move` / Fed call exists in `casino/mtt*.js` (a test scans them).
Conservation (test/casino-mtt.test.js, 27 entries at 1,000 + 100): wallets + held + House + incentives are equal before and after every money
step; the House gains exactly 2,700; every hold ends spent by the one settle.

### Guarantees and freerolls (the H2b date gate)

`casino/mttbudget.js`: `H2B_AT = Date.UTC(2026, 11, 1, 14, 0, 0, 0)` is a code constant - never a setting or an env var (`setSetting`
refuses anything with "h2b" in its name). The SPEND gate (paying an overlay): the date reached, `(await C.owner("budget")) === "site"`
(also false while `cutting` and after an H2b rollback), `(await C.ownership()).budget.paused === 0`, and `policy/budget.js` present with
`spendInTx` + `remaining` + `weekOf`. The CREATE gate (creating / editing a guarantee or a freeroll, and opening its registration) =
`mtt_guarantees` on + the spend gate. Once registration opens the guarantee is frozen and announced: turning the switch off never reneges -
the overlay checks only the spend gate. The emergency stop is pausing the budget feature (overlays stay pending, owed after 7 days).
`policy/budget.js` (PO-5, hand-off 23 D3) is not on this branch: the gate answers `no_budget_service` and the admin card says why
("Guarantees: locked until 2026-12-01 14:00 UTC" before H2b). Creation checks: G >= 1,000 and >= 10 PAT per paid place; the most it could
add (G - min x buy-in) <= `mtt_overlay_cap` (< 1M, so hand-off 23's 1M approval rule never applies); every budget week the play window
touches (PO-5's weekOf, else Monday 04:00 UTC weeks) <= `mtt_overlay_week_cap` (itself <= `budget_<group>`); the current week's headroom
minus the other unpaid guarantees. The group is `roomgames` (paced d/7 - a Monday finish may wait) or `misc`. Freerolls: buy-in 0, fee 0, no
re-entry, G > 0, entrants not auto accounts, level `mtt_freeroll_min_level`+, accounts `mtt_freeroll_min_age_days`+ old. Payees follow
merges (`ledger.resolveUserId`); a vanished account's share is forfeited (logged; it stays in the incentives pool). Nothing ever falls back
to the House, the Fed or a player's PAT. PO-5 contract needed (open point 1): `spendInTx({key, group, flow: "incentives:casino_mtt", legs,
ref, why, via, source: "incentives"})` in the caller's transaction - one keyed spend (incentives pool only, ONE incentive_spends row); a
terminal refusal recorded and RETURNED `{ok: false, terminal: true, code}`; non-terminal problems THROW with nothing recorded. A
single-destination PO-5 (`multiLeg: false`) gets the fallback: a headroom pre-check and one spend per leg `<key>:<place>`, all or nothing.

### Leaderboards, achievements, notices

Points per finish: floor(100 (sqrt(E / place) - 1)), 0 for the last place, only for tournaments that settle with E >= `mtt_points_min_field`,
best entry per player (`casino_mtt_points`, month = the finish's UTC 'YYYY-MM' + all time). Ranked by points, then wins, cashes, the earliest
time. Rows veiled at play time never count publicly; someone veiled NOW is left off entirely. Achievements (E >= `mtt_ach_min_field`; counted
once per player per tournament through `rewards.siteCount`): In the Money / Deep Runner (`mtt_cashes` 1 / 10), Final Table (`mtt_final_tables`,
only when it started with 2+ tables), Champion (`mtt_wins`). Notices: inbox kind `tourney` (🏆; Telegram opt-in - not default on; the page's
"also on Telegram" toggle sets it); 'starting' reminders for remind-on entrants and watchers, 'reg_open' for watchers, 'cancelled' and
'result' for every entrant; stale reminders are dropped (cancelled, started, re-dated). Room lines go to the announcement rooms with a
per-room budget (`mtt_room_lines_per_min`; extra bust lines merge); a player's own lines only to their own room. Pepe PMs room players their
hole cards, their turn prompts and the start / 15-minute notices (`private_mtt`, own fresh room only, `pmAllowed` for notices). Discord
(`mtt_discord`, a channel, kinds `mtt_discord_kinds` default starting + winner, the role only on starting - posted at the 15-minute mark,
"Starting soon", or at an admin's start-now, "Starting now"; once per (tournament, kind); never on staging - the bridge answers 409
`staging_disabled`). In `staff` mode the room lines, Discord posts and the stream slot still follow the tournament's rooms and the
settings: on prod, list staff rooms only and keep `mtt_discord` / `mtt_stream_final` as wanted while testing.

### Pepe's stream

The final table takes Pepe's stream slot (`mtt_stream_final`: take | queue | off) through `service.streamTake`: an empty slot is taken; a
TOURNAMENT table on the slot (a Sit & Go's or another MTT's) is never pre-empted - the final table queues after the last tournament table
queued; a cash table on the slot is pre-empted under "take" and goes to the head of the queue with its own line. The final table keeps the
slot while it holds (the tick refreshes it), an admin's "stream off" is respected (no re-take), and the finish releases it. Pepe reports
`scene: {held}` in every poll (an on-air pick or the IRL feed holds OBS): the line then says "goes on Pepe's stream as soon as the current
show ends".

### Restarts (every cut point)

Boot: ensure -> settings -> the stream -> the tournaments loaded (their clocks moved by the gap since the last beat - a restart never blinds
anyone up and costs at most the <= 30 s since the last beat) -> every open table recovered (an MTT table's hand resumes; a hand that ended is
wrapped up from its saved start record) -> `recoverAll` (the invariant: every playing entry exactly once at a live table or in transit,
every seat a playing entry, the chips add up - any violation pauses it by the system, no PAT moves, no guess; transit re-queued; never-dealt
tables released; running with one player left -> finishing) -> the tick (the start within the grace, the finish / overlay retries, the post
steps by flag, the reminders). Tests: test/casino-mtt-crash.test.js (every `mtt:<op>:in-tx` / `:after-commit` cut point).

### The contract (web + Pepe)

- `GET /api/casino/mtt` (and `/api/casino/lobby` -> `mtt`): `{mtt_on, audience, can_register, upcoming, registering, running, recent, mine}`,
  a row = `{id, no, title, status, start_at, est_ms, buyin, fee, guarantee, freeroll, registered, max_entries, structure: {kind, start_chips,
  level_mins, reentry_max, late_levels}, late_open, level, players_left, entries, final_table, url, prize_pool, me, my_table?}` (`my_table`:
  a seated entrant's own table - "Take me to my table").
- `GET /api/casino/mtt/:id` -> `{mtt, me, results}`; `/players?page=` (masked rows, no ids), `/tables`, `/me` (`{registered, state, gen,
  entries_used, can_register, can_reenter, table_id, table_no, stack, rank, moved_to, remind, watching, telegram_linked, telegram_tourney,
  place, prize, overlay, points}`); `GET /api/casino/mtt/leaderboard?period=YYYY-MM|all&page=n`.
- `POST /api/casino/mtt/:id/register {idem, remind}` · `/unregister {idem}` · `/remind {idem, on, telegram}` - JSON + `X-Requested-With:
  fetch`; 401 / 403 (the switch) / 404 / 409 / 429 (`remind` is refused once it has started). The leaderboard API is 403 while the switch
  hides it, like its page. Admin: `POST /api/casino/admin/mtt` (create / edit), `/api/casino/admin/mtt/:id/<cancel |
  void | pause | resume | start | delay | max | stream | overlay-retry>`, `/api/casino/admin/mtt/:id/entry/:n/(refund | dq)`, `GET
  /api/casino/admin/mtt[/:id[/log]]`. Settings: `casino_mtt` + `mtt_*` through `/api/casino/admin/settings` (validated by `checkMttSetting`).
- `GET /api/casino/t/:id` of an MTT table: `table.tourney` = `{kind: "mtt", id, no, name, table_no, tables_left, final, players_left,
  entries, avg_stack, level, sb, bb, next_level_at, level_secs_left (seconds left on the site's clock when the view was built), late_open, paid,
  prize_pool, guarantee, h4h, h4h_waiting_table, hold, paused, dead_sb, status, url}`; `me.tourney` = `{registered, mtt_rank, moved_to: {no, id} | null,
  result: {out, late_open} | {place, prize, tied, final} | null}` (the page moves you after 1.5 s; a busted / finished entrant gets the results card). The public part is
  cached a second per (table, rev); the page polls every 2 s off-turn.
- Pepe: `POST /api/casino/bot/act` with `game: "mtt"` (`!mtt` / `!tourney`), `verb` `list` | `info` | `join` | `leave` | `remind` | `me` | `top`
  | `pause` | `resume` | `cancel` (`args` up to 2: `[no, "off"|"remind"|"confirm"]`; pause / resume / cancel need `casino.admin` on the
  linked account). A room player's bare Hold'em verb (check, call, fold, raise, bet, allin, pre, cards, sitout, sitin) resolves turn-first
  (`svc.tourneyTableFor`), looking only at TOURNAMENT tables: the MTT table where it's their turn (at two at once: the one whose turn clock
  runs out first), their room's table if they sit there, the only MTT table they sit at (seated at two with no turn: "You're at more than one
  table - use the web, or !mtt me.", `pm: true`). A cash table or a Sit & Go elsewhere never takes a room's bare verb (a game-less `!bet`
  stays with the room's blackjack table). At an MTT table a successful action (check, call, fold, raise, bet, allin) is `quiet`; `!cards`,
  `!sitout`, `!sitin`, `!pre`, `!showhand` answer as a PM. The poll body carries `scene: {held}`; the answer adds `mtt_on` and
  `private_mtt: [{kind: "cards"|"turn"|"notice", key, camfrog, room, table, hand_no, cards?, text?}]` (dedupe by `key`: cards
  `<table>:<hand_no>:<camfrog_lower>`, turns `<table>:<hand_no>:<turn_token>`, notices the reminder ref). Room lines are events of kind
  `mtt` (`table` = the tournament's id, `data: {text, rooms, tid, no, url}`). A poll WITHOUT `scene` (a Pepe from before phase 2) gets no
  kind `mtt` events and no MTT table in `tables` (he would post the lines ungated and draw the final table as a Sit & Go).

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
