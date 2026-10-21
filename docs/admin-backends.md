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

2. It records the wish in `backend_wants (feature, want, by, by_user, via, at)` in the same transaction.
3. After the commit: `admin_audit` action `backend_switch`, detail `{feature, want, was, live, via}`.

Nothing moves on the site from here: Pepe runs each hand-over (freeze -> export -> verify the totals) or way back himself.

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
| `POST /api/admin/backends/:feature {on}` | a same-origin fetch (`X-Requested-With: fetch` + an Origin / Referer naming the site; none is refused); Admins, + a Pepe owner on an owner row. 400 when `on` isn't true / false, 404 for an unknown feature, 403 `cross_site` / `admin_only` / `owner_only`, 409 `E_LIVE` (stashes) |
| `POST /api/pepe/backends {password}`   | Pepe (bot token)                                |

`POST /api/pepe/backends` answers

```json
{ "ok": true, "ts": 1792000000000,
  "features": { "lotto": { "want": true, "live": false, "site": null, "by": "boss", "at": 1792000000000 },
                "stashes": { "want": null, "live": true, "site": true, "by": null, "at": null }, "...": {} } }
```

- `want`: `true` / `false` from this page, `null` = never switched here (Pepe keeps what he does today).
- `live`: the site owns it now. `site`: the feature's own site switch (`null` = none: the lotto).
- When `want` differs from `live`, Pepe still has to move it - at his next quiet moment (between draws, no heist or fight
  running), with the feature's own hand-over or way back.

## Pepe's side (the bot slice)

- The panel's Backends card shows these switches read-only, with a link to `/admin/backends`.
- Pepe reads `POST /api/pepe/backends` and follows each wish with the module's own handler (lotto cutover / rollback,
  the stash hand-over, the GTF hand-over / way back, poll attach / detach, the drop table hand-over / release, the AI
  judge's proposals on / off). A `null` wish changes nothing.
- The staging sandbox (`staging.py`) needs a handler for `/api/pepe/backends`.
- The VPS shell tools stay the emergency path.
