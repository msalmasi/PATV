# Admin › Backends: the hand-overs, switched from the site

Site `backends.js` (`/admin/backends`). Owner answers of 2026-10-20:

- **(2)** Pepe's local admin panel "Backends" card (`pepe_backends.py`) is **read-only**. The hand-overs it used to flip
  (the lotto, the stashes, the GTF records, the polls, the cosmetic drop table, the AI judge) are switched on the site's
  `/admin/backends`, never on a public feature page, and every switch is audited.
- **(1)** A switch that holds or moves members' PAT is a **Pepe owner's**: the Admin class AND the owner role on the
  account's linked Camfrog login, read fresh from the database (`staffroles.ownerOf`), like the economy writes. On this
  page: the lotto (its pot) and the stashes. The GTF, polls, cosmetics (drop table) and oracle (AI judge) switches stay
  Admins'.

## What a switch is

The switch is the **wish** for where a feature lives: `want: true` = on publicaccess.tv, `false` = on Pepe.

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

2. It records the wish in `backend_wants (feature, want, by, by_user, via, at, act, pepe_at, pepe_ok, pepe_msg)` in the same
   transaction. `act` = Pepe followed that feature's switch when the wish was made (see "Does Pepe follow it?").
3. After the commit: `admin_audit` action `backend_switch`, detail `{feature, want, was, live, via, pepe_follows}`.

Nothing moves on the site from here: Pepe runs each hand-over (freeze -> export -> verify the totals) or way back himself.

## Does Pepe follow it? (review of the owner answers, 2026-10-20)

A switch only moves a feature once Pepe **reads** these switches and runs the hand-over himself. Until his update ships, he
doesn't - so the page never says he will:

- Pepe's poll of `POST /api/pepe/backends` carries `follows` (the hand-overs he runs from a wish) and `version`; the site keeps
  the last one (`backend_reader`). A read older than 15 minutes counts as **not following** (an old Pepe, or he is down).
- A row Pepe follows: the switch is his to act on, at his next quiet moment.
- A row he doesn't follow: the page names the chat command a Pepe owner runs instead, and the switch only sets the site's
  side (the stashes / GTF / polls / AI judge switches - the site takes or refuses the hand-over). A switch that would write
  nothing on the site - the lotto (both ways) and the drop table's release while the site owns it - is **refused** (409
  `pepe_not_following`, with the chat command): it would change nothing.

  | Feature  | Chat command (owners), on / off                                   |
  |----------|-------------------------------------------------------------------|
  | lotto    | `!lotto backend cutover confirm` / `!lotto backend rollback confirm` |
  | stashes  | `!stash backend on` / `!stash backend off`                        |
  | gtf      | `!gtf backend on` / `!gtf backend off`                            |
  | polls    | `!poll backend on` / `!poll backend off`                          |
  | cosdrops | `!cosmetics backend on confirm` / `!cosmetics backend off confirm` |
  | aijudge  | `!aijudge backend on confirm` / `!aijudge backend off confirm`    |

- A wish made while Pepe didn't follow that feature has `act: false`: he leaves it alone, so a switch flipped before his
  update never starts a hand-over by surprise later. Switch it again once he follows it.
- His `results` (what he did for the CURRENT wish) are shown on the row; a new wish clears them; a result for an older wish
  is ignored.
- Website forms can't switch a hand-over: `actions.js` refuses a `"<cmd> backend ..."` form and a poll form starting with
  "backend" before anything runs or is queued for Pepe (the bot refuses them too since PO-0c `c9c6fcf`).

The old per-feature routes keep their rules and also record the wish + the audit row (`via: "web-legacy"`):
`/api/admin/stash-backend` (owners), `/api/admin/gtf-backend`, `/api/admin/polls-backend`, `/api/admin/oracle`, the
`switch` of `/api/admin/cosmetic-drops` (Admins). The lotto's live switch `lotto_backend` from the web
(`/api/lotto/admin/settings`) is an owner's; the bot token and `tools/lotto-admin.js` are unchanged.

Status only (cut over live with their runbooks, as on Pepe's panel): the pools, capital (markets, Reserve loans, vaults),
the escrow ledger, gangs and the achievement counters. Their site switches are on `/admin/economy` and in
`tools/*-backend.js`. The casino is per room, switched in chat (`!casino backend`); its engines are on Admin › Games.

## Routes

| Route                                  | Who                                             |
|----------------------------------------|-------------------------------------------------|
| `GET /admin/backends`                  | Admins (`econ.backend_cutover`)                 |
| `GET /api/admin/backends`              | Admins: `{rows, status, owner, admin}`          |
| `POST /api/admin/backends/:feature {on}` | a same-origin fetch (`X-Requested-With: fetch` + an Origin / Referer naming the site; none is refused); Admins, + a Pepe owner on an owner row. 400 when `on` isn't true / false, 404 for an unknown feature, 403 `cross_site` / `admin_only` / `owner_only`, 409 `E_LIVE` (stashes), 409 `pepe_not_following` (a wish-only switch Pepe doesn't follow). 200 `{feature, want, live, site, pepe, act, chat}` - `chat` = the owner's command while Pepe doesn't follow it |
| `POST /api/pepe/backends {password, follows?, version?, results?}` | Pepe (bot token)          |

Pepe sends (contract 1)

```json
{ "password": "<bot token>", "version": "1.99zz", "follows": ["lotto", "stashes", "gtf", "polls", "cosdrops", "aijudge"],
  "results": { "lotto": { "want": true, "ok": false, "msg": "within 10 minutes of the draw - waiting" } } }
```

and gets

```json
{ "ok": true, "ts": 1792000000000, "contract": 1,
  "features": { "lotto": { "want": true, "act": true, "live": false, "site": null, "by": "boss", "at": 1792000000000 },
                "stashes": { "want": null, "act": false, "live": true, "site": true, "by": null, "at": null }, "...": {} } }
```

- `follows`: only the features he runs from a wish (unknown keys are dropped). Leave it out to read without reporting.
- `want`: `true` / `false` from this page, `null` = never switched here (Pepe keeps what he does today).
- `act`: follow the wish only when true (it was made while he followed that feature).
- `live`: the site owns it now. `site`: the feature's own site switch (`null` = none: the lotto).
- When `want` differs from `live` and `act` is true, Pepe moves it at his next quiet moment (between draws, no heist or
  fight running), with the feature's own hand-over or way back, and reports it in `results` (`want` = the wish it was for).

## Pepe's side (the bot slice - NOT built yet)

- The panel's Backends card shows these switches read-only, with a link to `/admin/backends` (PO-0c `c9c6fcf`).
- **To build:** Pepe polls `POST /api/pepe/backends` every few minutes with `follows` + `version`, and follows each wish with
  `act: true` with the module's own handler (lotto cutover / rollback, the stash hand-over, the GTF hand-over / way back,
  poll attach / detach, the drop table hand-over / release, the AI judge's proposals on / off) at a quiet moment, then
  reports `results`. A `null` wish, or `act: false`, changes nothing. Until he does, the page shows "Pepe doesn't read these
  switches yet" and each row's chat command.
- The staging sandbox (`staging.py`) needs a handler for `/api/pepe/backends`.
- The VPS shell tools stay the emergency path. They never open a database that isn't there (`tools/sitedb.js`: no
  `./myapp.db` -> exit 2; `--dir=<folder>`), and a switch from the shell writes the same audit row (`via: "cli"`) and, for
  the stashes, the same wish.

## What else holds or moves PAT, and who may do it (owner answer (1), review of 2026-10-20)

Owner-only (the Admin class AND Pepe's owner role on the linked login, read fresh): the economy writes (PO-0b), the PAT grant
and the House adjust (with the password step-up), the auto-escrow switch, the pad-vault admin move, donation promos, the
lotto_backend web switch, redemption codes, welcome "pay anyway", a held crypto payment's approve / re-verify / **un-ignore**
(it re-settles the payment), a **House raffle with a PAT prize** (the House pays the winner, up to `prize_max`), granting /
approving / forgiving a **Federal Reserve loan** (the site's `/wallet` Reserve form; queued `!loan grant | approve | forgive`
forms carry `site_admin` = the owner check at claim time), and the lotto and stashes rows here.

Kept with Admins - adjudication inside a game's own rules, where the PAT only goes to that game's participants (or back to
the payers), like the oracle (AI judge) the owner kept with Admins. Listed for the owner to confirm:

| Power (`escrow.override`)                                  | Where                                         |
|------------------------------------------------------------|-----------------------------------------------|
| reject a bounty claim, decide a bounty dispute             | `bounties.js`, `escrow/bounties.js`           |
| settle / cancel / re-settle a market as an admin           | `markets.js` (judge), `capital/markets.js`, `escrow/pools.js` |
| settle a wager as an admin (not the judge)                 | `escrow/wagers.js`, `wagers.js`               |
| end a poll as an admin                                     | `polls.js`                                    |
| a raffle's dispute decision (release / refund) and takedown (refunds) | `raffles.js`                       |
| `site_admin` on every other website `cmd` action Pepe runs (judging in chat terms) | `actions.js`          |
| deny a Reserve loan request (moves nothing)                | `capital/reserve.js`                          |

Not a PAT power: the lotto's web `admin` flag (`lotto/routes.js` webActor) - `lotto/service.buy` never reads it; the forced
draw is Pepe's bot-token route.
