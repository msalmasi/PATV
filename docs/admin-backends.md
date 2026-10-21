# Admin › Backends: the hand-overs and the casino's rooms, switched from the site

Site `backends.js` (`/admin/backends`); Pepe's side is camfrog-bot `pepe_backends.py`. **This file is the single source of the
contract between them** ("The contract" below), pinned by a shared fixture that both repos test against.

Owner answers:

- **(2), 2026-10-20** - Pepe's local admin panel "Backends" card (`pepe_backends.py`) is **read-only**. The hand-overs it used
  to flip (the lotto, the stashes, the GTF records, the polls, the cosmetic drop table, the AI judge) are switched on the site's
  `/admin/backends`, never on a public feature page, and every switch is audited.
- **(1), 2026-10-20** - a switch that holds or moves members' PAT is a **Pepe owner's**: the Admin class AND the owner role on
  the account's linked Camfrog login, read fresh from the database (`staffroles.ownerOf`), like the economy writes. On this page:
  the lotto (its pot), the stashes and the casino. The GTF, polls, cosmetics (drop table) and oracle (AI judge) switches stay
  Admins'.
- **(6), 2026-10-21** - the **casino's per-room switch** (`!casino backend on|off`, `!backend all on|off`) moved here, as
  per-room switches plus the default for rooms Pepe joins later, **owner-only** (the casino holds PAT). Pepe follows them through
  the same contract. In chat `!casino backend …` / `!backend all …` only show the status and point here - owners included. The
  shell's emergency path is `tools/casino-backend.js`.
- **(4), 2026-10-21** - **judging stays with Admins** (confirmed - see "Judging" at the end).
- **(5), 2026-10-21** - Pepe-side owner-only: `!loan approve|grant` from the Bank's cash, and the panel's burn, Reserve fund and
  sink-rate edits; moderation fines (`!fine`, `!padfine`, `!padmove`) stay with Admins / staff - see "What else holds or moves
  PAT" at the end.

## What a switch is

A hand-over switch is the **wish** for where a feature lives: `want: true` = on publicaccess.tv, `false` = on Pepe.

1. It writes the feature's own site switch the way the old per-feature routes and `tools/*-backend.js` do (the site takes
   Pepe's hand-over only while it is on). The rule per feature:

   | Feature  | Who     | Site switch written                         | Off while the site owns it                                  |
   |----------|---------|---------------------------------------------|-------------------------------------------------------------|
   | lotto    | owners  | none (Pepe's import turns `lotto_backend` on, his export turns it off) | the wish only: Pepe's rollback, between draws |
   | stashes  | owners  | `stash_meta.enabled`                        | refused (409 `E_LIVE`): the import is for good; only a detach on Pepe |
   | gtf      | admins  | `gtf_meta.enabled`                          | written (refuses new imports); Pepe's way back releases the records |
   | polls    | admins  | `polls_meta.enabled`                        | written: the site stops owning them at once (as before)     |
   | cosdrops | admins  | `cosmetic_drop_meta.enabled`                | the wish only: Pepe releases the table (`pepe: true`)       |
   | aijudge  | admins  | `oracle_meta.enabled`                       | written: proposals are refused, Pepe decides locally        |

2. It records the wish in `backend_wants (feature, want, by, by_user, via, at, act, pepe_at, pepe_ok, pepe_msg, pepe_state)` in
   the same transaction. `act` = Pepe followed that switch when the wish was made (see "Does Pepe follow it?").
3. After the commit: `admin_audit` action `backend_switch`, detail `{feature, want, was, live, via, pepe_follows}`.

Nothing moves on the site from here: Pepe runs each hand-over (freeze -> export -> verify the totals) or way back himself.

The **casino** is different: nothing moves when it flips (tables in flight on the site are settled by the site) and the site has
no switch of its own for it - the per-room switch is Pepe's (`casino_client.json`). A casino switch is only the wish, so it needs
Pepe to follow it (below). `backend_wants.feature` is `"casino:<room id>"` for a room and `"casino"` for the rooms Pepe joins
later.

## Does Pepe follow it?

A switch only moves a feature once Pepe **reads** these switches and runs the hand-over himself:

- Pepe reads `POST /api/pepe/backends` every minute (the contract below). The site keeps his last read in this contract
  (`backend_reader`: when, his version, what he follows, his casino rooms). A read older than 15 minutes counts as **not
  following** (an old Pepe, or he is down).
- A row Pepe follows: the switch is his to act on, at his next quiet moment (a casino switch: within a minute).
- A row he doesn't follow: the page names the chat command a Pepe owner runs instead, and the switch only sets the site's side
  (the stashes / GTF / polls / AI judge switches - the site takes or refuses the hand-over). A switch that would write nothing on
  the site - the lotto (both ways), the drop table's release while the site owns it, and every casino switch - is **refused**
  (409 `pepe_not_following`): it would change nothing.

  | Feature  | Chat command (owners), on / off - while Pepe doesn't follow the switch |
  |----------|-------------------------------------------------------------------|
  | lotto    | `!lotto backend cutover confirm` / `!lotto backend rollback confirm` |
  | stashes  | `!stash backend on` / `!stash backend off`                        |
  | gtf      | `!gtf backend on` / `!gtf backend off`                            |
  | polls    | `!poll backend on` / `!poll backend off`                          |
  | cosdrops | `!cosmetics backend on confirm` / `!cosmetics backend off confirm` |
  | aijudge  | `!aijudge backend on confirm` / `!aijudge backend off confirm`    |
  | casino   | (an older Pepe only) `!casino backend on\|off` in the room - read-only in chat since owner answer (6) |

- A wish made while Pepe didn't follow that switch has `act: false`: **he never runs it**, so a switch flipped before his update
  (or while he was down) never starts a hand-over by surprise later. He reports it as "switched before Pepe followed it - switch
  it again" (state `unacted`) - or as done, if it is already there (an owner ran it in chat meanwhile). Switch it again once he
  follows it.
- His `results` (what he did for each CURRENT wish) are shown on the row; a new wish clears them; a result for an older wish is
  ignored.
- Website forms can't switch a hand-over: `actions.js` refuses a `"<cmd> backend ..."` form and a poll form starting with
  "backend" before anything runs or is queued for Pepe (the bot refuses them too since PO-0c `c9c6fcf`).

The old per-feature routes keep their rules and also record the wish + the audit row (`via: "web-legacy"`):
`/api/admin/stash-backend` (owners), `/api/admin/gtf-backend`, `/api/admin/polls-backend`, `/api/admin/oracle`, the
`switch` of `/api/admin/cosmetic-drops` (Admins). The lotto's live switch `lotto_backend` from the web
(`/api/lotto/admin/settings`) is an owner's; the bot token and `tools/lotto-admin.js` are unchanged.

Status only (cut over live with their runbooks, as on Pepe's panel): the pools, capital (markets, Reserve loans, vaults),
the escrow ledger, gangs, the achievement counters, the policy engines and the Fed events. Their site switches are on
`/admin/economy` and in `tools/*-backend.js`. The casino's engines (blackjack, Hold'em) are on Admin › Games.

## The contract

`POST /api/pepe/backends` (bot token), **contract 1**. The shared fixture `test/fixtures/backends-contract.json` holds a whole
conversation (the old Pepe's body, three reads of this build with the switches made between them, the exact answers, what the
site keeps and what Pepe runs) plus probes - see "The shared fixture".

### Pepe sends (every minute)

```json
{ "password": "<bot token>", "contract": 1, "version": "1.99zz",
  "follows": ["lotto", "stashes", "gtf", "polls", "cosdrops", "aijudge", "casino"],
  "results": { "lotto":          { "want": true, "at": 1792000070000, "ok": true,  "state": "done",    "msg": "DONE - the lotto runs on publicaccess.tv" },
               "stashes":        { "want": true, "at": 1792000010000, "ok": false, "state": "unacted", "msg": "switched before Pepe followed it - switch it again" },
               "casino:PepeLab": { "want": true, "at": 1792000071000, "ok": true,  "state": "done",    "msg": "on the publicaccess.tv casino backend" } },
  "casino": { "default": true, "rooms": [ { "room": "DRAMA_CENTRAL", "name": "DRAMA_CENTRAL", "joined": true, "on": false },
                                          { "room": "PepeLab", "name": "Pepe Lab", "joined": true, "on": true } ] } }
```

- `contract`: 1. **The site records a reader only for `contract: 1` with a `follows` list** - anything else (the bot before this
  contract posted only the token; a Pepe in another contract number) is answered but never counts as following, so the page
  never says he follows switches he can't act on.
- `version`: Pepe's VERSION file (shown on the page).
- `follows`: what THIS build can run from a wish - the hand-overs whose module switches are in the build, plus `"casino"` with the
  casino client. Empty while his `backends_follow.json` is unreadable (he follows nothing then). Keys the site doesn't know are
  dropped.
- `results`: per CURRENT wish Pepe holds - `want` + `at` name the wish (the site stores a result only where both match the row:
  a result for an older wish is ignored), `ok` = it is where the site wants it, `state` one of `done | unacted | pending |
  waiting | trying | blocked | stuck`, `msg` his words (max 300 characters, control characters removed). Keys: a hand-over,
  `"casino"` (the new-rooms default), `"casino:<room id>"`.
- `casino`: his casino as it is now - the new-rooms `default` and every room he is in or keeps switched on (`room` id, its
  `name`, `joined`, `on` = plays on the site's casino). At most 50 rooms; the site keeps the last list (`backend_reader.casino`)
  for the page's rows - only a room in it (or one that already has a wish) can be switched.

### The site answers

```json
{ "ok": true, "ts": 1792000180000, "contract": 1,
  "features": { "lotto":   { "want": true, "act": true,  "live": false, "site": null, "by": "boss", "at": 1792000070000 },
                "stashes": { "want": true, "act": false, "live": false, "site": true, "by": "boss", "at": 1792000010000 },
                "gtf":     { "want": null, "act": false, "live": false, "site": false, "by": null, "at": null }, "...": {} },
  "casino": { "default": { "want": true, "act": true, "by": "boss", "at": 1792000072000 },
              "rooms":   { "PepeLab": { "want": true, "act": true, "by": "boss", "at": 1792000071000 } } } }
```

- `want`: `true` / `false` from this page, `null` = never switched here (Pepe keeps what he does today).
- `act`: follow the wish only when `true` (it was made while he followed that switch). **Pepe never runs a wish whose `act`
  isn't `true`.**
- `live`: the site owns it now. `site`: the feature's own site switch (`null` = none: the lotto).
- `casino.rooms`: only rooms with a wish; `casino.default` is always there (`want: null` = never switched here).
- `contract`: Pepe follows nothing from an answer in another contract number (whatever its wishes say) and says so on his card
  and in `!backend status`.
- When `want` differs from where Pepe has it and `act` is true, Pepe moves it: a hand-over at his next quiet moment (between
  draws, no heist or fight running; one hand-over per pass; retried after 10 / 20 / 30 / 60 min; given up after 24 h with one
  notice to the admins), a casino switch in the same pass (a room with an old-engine table open waits for that table to end). A
  wish reached once is never re-applied over a later change made another way. He reports it in the next read's `results`.
- Pepe ignores a feature key he doesn't know, and an answer without the `casino` block leaves his casino alone.

### The shared fixture

`test/fixtures/backends-contract.json` here and `ci/fixtures/backends-contract.json` in camfrog-bot are **byte-identical**.
Their sha256 is pinned in both tests: `test/backends-contract.test.js` (`PIN`) here, `backends_contract_test.py` (`PIN`) in the
bot. `.gitattributes` keeps the file LF in every checkout (`text eol=lf`) in both repos.

- The site test feeds every request through the real route (`backends.js`), with the switches made between reads through the
  real `/api/admin/backends/:feature` route as the fixture's owner, and checks the exact answer and what the site keeps (the
  reader, the results). Its probes: unknown keys dropped, a result for an older wish ignored, another contract number not
  recorded.
- The bot test builds every request of this build from Pepe's real state (`_bkf_body`: contract, the VERSION, what the build
  follows, his results, his casino rooms) and checks it equals the fixture's exact body (the token added as `password`, exactly
  as `frida-bot._backend_post` does); it feeds every answer through the real follower and checks what he runs. Its probes: an
  unknown feature, another contract number, `act: false` (a hand-over and a casino room), an answer without the casino block.
- Each test fails when its copy's sha256 isn't the pinned one. With the other repo checked out, set `PEPE_BOT_DIR=<camfrog-bot>`
  (site test) / `PATV_SITE_DIR=<PATV>` (bot test) and each also compares the other copy byte for byte.

**Changing the contract** (both repos together, never one):

1. Change the code on both sides and this section.
2. Edit the fixture in ONE repo (it is plain JSON, 2-space indent, LF), then copy the file byte for byte to the other repo.
3. Re-pin both tests with the new sha256 (`sha256sum test/fixtures/backends-contract.json`, or
   `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))" <file>`).
4. Run both tests (`NODE_PATH=... node --test test/backends-contract.test.js` with `PEPE_BOT_DIR` set;
   `PATV_SITE_DIR=... python backends_contract_test.py`), then both full suites; commit both repos. A new contract number means
   an older Pepe follows nothing from the new site (and the reverse) until both are updated - ship the site first only when the
   older Pepe's behaviour against it is what you want.

## The casino's per-room switch (owner answer 6)

On `/admin/backends#casino`: one row per room Pepe listed (where it plays now, the wish, what Pepe said), one for **new rooms
Pepe joins**, and "every room" buttons - offered to a Pepe owner while Pepe follows the casino switches.

- `POST /api/admin/backends/casino {on, scope: "room" | "default" | "all", room?}` - a same-origin fetch; a Pepe owner
  (`mayFlipCasino`). `room`: one room Pepe listed (or one that already has a wish; 404 `unknown_room` otherwise). `default`: the
  rooms Pepe joins later (the rooms he is in keep what they play on). `all`: every room he listed + the default, in one
  transaction (the old `!backend all`). Refused with 409 `pepe_not_following` while Pepe doesn't follow it (a stale read). The
  audit row: `backend_switch` `{feature: "casino", scope, room, rooms (all), want, was, via, pepe_follows}`.
- Pepe follows each wish with pepe_casino's own switch (`_cbj_set_room` / `_cbj_set_default`): no quiet moment needed (nothing
  moves), not counted as the pass's one hand-over; a room with a table still open on his old engine switches once it ends.
- Chat: `!casino backend [status]`, `!casino backend all status`, `!backend status` show it; `on|off`, `all on|off`,
  `default on|off`, `!backend all on|off` only answer with where it is switched - owners included.
- **Emergency path** (the shell): `tools/casino-backend.js` - `[status]`, `--actor=<who> room <room id> on|off`,
  `--actor=<who> default on|off`, `--actor=<who> all on|off` (`--dir=<folder with myapp.db>`; no `./myapp.db` -> exit 2, nothing
  opened). It writes the same wish (`via: "cli"`) and audit row, and is refused the same way while Pepe doesn't follow the switch.
  Note: when the site itself is down Pepe can't read any switch - a casino room on the backend then answers "the site isn't
  answering" until it is back; the last resort is `casino_client.json` on Pepe's VM, edited with Pepe stopped.

## Routes

| Route                                  | Who                                             |
|----------------------------------------|-------------------------------------------------|
| `GET /admin/backends`                  | Admins (`econ.backend_cutover`)                 |
| `GET /api/admin/backends`              | Admins: `{rows, status, owner, admin, reader, casino}` |
| `POST /api/admin/backends/:feature {on}` | a same-origin fetch (`X-Requested-With: fetch` + an Origin / Referer naming the site; none is refused); Admins, + a Pepe owner on an owner row. 400 when `on` isn't true / false, 404 for an unknown feature, 403 `cross_site` / `admin_only` / `owner_only`, 409 `E_LIVE` (stashes), 409 `pepe_not_following` (a wish-only switch Pepe doesn't follow). 200 `{feature, want, live, site, pepe, act, chat}` - `chat` = the owner's command while Pepe doesn't follow it |
| `POST /api/admin/backends/casino {on, scope, room?}` | the same origin rule; a Pepe owner. 400, 403 as above, 404 `unknown_room`, 409 `pepe_not_following`. 200 `{feature: "casino", scope, room, rooms, want, act}` |
| `POST /api/pepe/backends {password, contract, version, follows, results, casino}` | Pepe (bot token) - "The contract" |

## Pepe's side (camfrog-bot)

- The panel's Backends card shows these switches read-only, with a link to `/admin/backends` (PO-0c `c9c6fcf`), each hand-over's
  wish and how far Pepe got, and the casino's rooms with theirs.
- `pepe_backends._bk_follow_tick` (heartbeat) reads the switches every minute on a pooled thread and follows them as above
  (`backends_follow.json` remembers each wish he reached; unreadable -> he follows nothing and says so).
- A site without this route (its JSON 404) is asked again every 10 minutes; meanwhile the hand-overs are owners' chat commands.
- The staging sandbox (`staging.py`) answers the route with "no answer" (Pepe follows nothing there).

## What else holds or moves PAT, and who may do it

**Owner-only** (the Admin class AND Pepe's owner role on the linked login, read fresh): the economy writes (PO-0b), the PAT grant
and the House adjust (with the password step-up), the auto-escrow switch, donation promos, the lotto_backend web switch, redemption
codes, welcome "pay anyway", a held crypto payment's approve / re-verify / **un-ignore** (it re-settles the payment), a **House
raffle with a PAT prize** (the House pays the winner, up to `prize_max`), granting / approving / forgiving a **Federal Reserve
loan** (the site's `/wallet` Reserve form; queued `!loan grant | approve | forgive` forms carry `site_admin` = the owner check at
claim time), and the lotto, stashes and casino rows here.

**Pepe's side, owner answer (5), 2026-10-21** (an owner by role - `pepe_acl` level, never a command grant):

- `!loan approve` / `!loan grant` (they pay the Bank's - or the Reserve's - cash to a member), on Pepe's own loan desk and while
  the capital cluster lives on the site (Pepe checks it before he asks the site, which trusts his actor); forgiving a Reserve loan
  too (the site's rule). `!loan requests` and `!loan deny` stay Admins'.
- Pepe's admin panel has one shared password and no identity, so it **refuses** what is an owner's and points to the owner paths:
  the burn (preview / burn, and the mode / caps / accrual tick - its announcement knobs stay), the Reserve fund (`/api/reserve/fund`
  and the economy card's "Fill a pool from the Reserve", `/api/econ/fund`), and any change to an **economy** sink-rate row
  (`pepe_econcfg.ECON_SINK_KEYS`: vault ceiling / cushion, Bank, Reserve loans, fees, Casino vault - from the Sink rates card or an
  economy-config key that is an alias of one; the game rows - rakes, prices, faucets - stay the panel's). Owners: `!burn`,
  `!burn mode`, `!burn set per_burn_max|daily_max|accrual_every_min <n>`, `!econ fund`, `!econ fedloan`, `!econ set`,
  `!econ sink <key> <value|default>` in chat (all owner-only, `pepe_acl.OWNER_POWERS`), or this site's Admin › Economy.
- **Moderation fines stay with Admins / staff**: `!fine`, `!padfine`, `!padmove` in chat, and their website form on
  `/pads/admin` ("Pad vault fines & transfers": site Admins with the password step-up; the website action `roomvault.admin`
  carries the Admin class again - the 2026-10-20 owner gate on it is gone).

## Judging (owner answer (4), 2026-10-21: stays with Admins - confirmed)

Adjudication inside a game's own rules, where the PAT only goes to that game's participants (or back to the payers), like the
oracle (AI judge) the owner kept with Admins. **Confirmed by the owner on 2026-10-21: these stay Admins'** (nothing here is
owner-gated, on the site or on Pepe):

| Power (`escrow.override` and friends)                      | Where                                         |
|------------------------------------------------------------|-----------------------------------------------|
| reject a bounty claim, decide a bounty dispute             | `bounties.js`, `escrow/bounties.js`           |
| settle / cancel / re-settle a market as an admin           | `markets.js` (judge), `capital/markets.js`, `escrow/pools.js` |
| settle a wager as an admin (not the judge)                 | `escrow/wagers.js`, `wagers.js`               |
| settle a betting pool as an admin                          | `escrow/pools.js`                             |
| end a poll as an admin                                     | `polls.js`                                    |
| a raffle's dispute decision (release / refund) and takedown (refunds) | `raffles.js`                       |
| `site_admin` on every other website `cmd` action Pepe runs (judging in chat terms) | `actions.js`          |
| deny a Reserve loan request (moves nothing)                | `capital/reserve.js`, Pepe's `!loan deny`     |

Not a PAT power: the lotto's web `admin` flag (`lotto/routes.js` webActor) - `lotto/service.buy` never reads it; the forced
draw is Pepe's bot-token route.
